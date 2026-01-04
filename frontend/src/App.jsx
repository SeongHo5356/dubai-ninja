import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:3001";
const PRICE = 4900;

const ACCOUNT_INFO = {
  bank: "카카오뱅크",
  number: "3333-02-1234567",
  holder: "두바이쫀득쿠키",
};

const STATUS_LABELS = {
  pending_payment: "입금 확인 대기",
  paid: "입금 확인 완료",
  ready: "픽업 준비 완료",
  picked_up: "수령 완료",
};

const statusClassName = (status) => {
  if (status === "picked_up") return "pill picked";
  if (status === "paid") return "pill paid";
  return "pill";
};

const VIEWS = {
  landing: "landing",
  order: "order",
  payment: "payment",
  complete: "complete",
  lookup: "lookup",
  admin: "admin",
};

const DEPOSITOR_WORDS = [
  "달빛",
  "모래",
  "바다",
  "봄",
  "구름",
  "별",
  "감귤",
  "바닐라",
  "카카오",
  "숲",
  "도넛",
  "마카롱",
  "오로라",
  "미소",
  "하늘",
];

const randomDepositorName = () => {
  const index = Math.floor(Math.random() * DEPOSITOR_WORDS.length);
  const number = Math.floor(1000 + Math.random() * 9000);
  return `${DEPOSITOR_WORDS[index]}${number}`;
};

const formatPhoneHint = (value) => {
  const digits = value.replace(/[^0-9]/g, "").slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) {
    return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  }
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
};

const isValidPhone = (value) => {
  const digits = value.replace(/[^0-9]/g, "");
  return digits.length === 11 && digits.startsWith("010");
};
const formatPrice = (value) =>
  new Intl.NumberFormat("ko-KR").format(value);

function App() {
  const [view, setView] = useState(
    window.location.pathname === "/cannot/admin" ? VIEWS.admin : VIEWS.landing
  );
  const [pickupInfo, setPickupInfo] = useState(null);
  const [orderForm, setOrderForm] = useState(() => ({
    name: "",
    phone: "",
    quantity: 1,
    depositorName: randomDepositorName(),
  }));
  const [orderData, setOrderData] = useState(null);
  const [lookupForm, setLookupForm] = useState({ phone: "", code: "" });
  const [lookupResult, setLookupResult] = useState(null);
  const [adminId, setAdminId] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminOrders, setAdminOrders] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const sseRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const retryCountRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const refreshPickupInfo = useCallback(() => {
    return fetch(`${API_BASE}/api/pickup-info`)
      .then((res) => res.json())
      .then((data) => setPickupInfo(data))
      .catch(() => setPickupInfo(null));
  }, []);

  useEffect(() => {
    refreshPickupInfo();
  }, [refreshPickupInfo]);

  useEffect(() => {
    let active = true;

    const handleStock = (event) => {
      try {
        const data = JSON.parse(event.data);
        setPickupInfo((prev) =>
          prev ? { ...prev, remaining: data.remaining, limit: data.limit } : prev
        );
      } catch (err) {
        // ignore parsing errors
      }
    };

    const connect = () => {
      if (!active) return;
      if (sseRef.current) {
        sseRef.current.close();
      }
      const source = new EventSource(`${API_BASE}/api/stock-stream`);
      sseRef.current = source;

      source.addEventListener("stock", handleStock);
      source.onopen = () => {
        retryCountRef.current = 0;
      };
      source.onerror = () => {
        source.close();
        const retry = Math.min(30000, 1000 * 2 ** retryCountRef.current);
        retryCountRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(connect, retry);
      };
    };

    connect();

    return () => {
      active = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (sseRef.current) {
        sseRef.current.removeEventListener("stock", handleStock);
        sseRef.current.close();
      }
    };
  }, []);

  const statusLabel = useMemo(() => {
    if (!orderData?.status) return "";
    return STATUS_LABELS[orderData.status] || orderData.status;
  }, [orderData]);

  const remaining = pickupInfo?.remaining;
  const isSoldOut = typeof remaining === "number" && remaining <= 0;
  const exceedsRemaining =
    typeof remaining === "number" && orderForm.quantity > remaining;
  const remainingText =
    isSoldOut
      ? "오늘 주문 마감"
      : typeof remaining === "number"
      ? `남은 수량 ${remaining}/${pickupInfo?.limit ?? "-"}`
      : "남은 수량 확인 중";

  const handleOrderSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (!isValidPhone(orderForm.phone)) {
        throw new Error("휴대폰 번호를 확인해주세요. (예: 010-1234-5678)");
      }
      if (!orderForm.depositorName) {
        setOrderForm((prev) => ({
          ...prev,
          depositorName: randomDepositorName(),
        }));
      }
      const response = await fetch(`${API_BASE}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orderForm),
      });

      const data = await response.json();
      if (!response.ok) {
        if (typeof data.remaining === "number") {
          setPickupInfo((prev) =>
            prev ? { ...prev, remaining: data.remaining } : prev
          );
        }
        throw new Error(data.error || "주문 실패");
      }

      setOrderData(data);
      if (data.pickupInfo) {
        setPickupInfo(data.pickupInfo);
      }
      setView(VIEWS.payment);
    } catch (err) {
      setError(err.message || "주문에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const handleLookupSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setLoading(true);
    setLookupResult(null);

    try {
      if (!isValidPhone(lookupForm.phone)) {
        throw new Error("휴대폰 번호를 확인해주세요. (예: 010-1234-5678)");
      }
      const params = new URLSearchParams({
        phone: lookupForm.phone,
        code: lookupForm.code,
      });
      const response = await fetch(`${API_BASE}/api/orders/lookup?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "조회 실패");
      setLookupResult(data);
    } catch (err) {
      setError(err.message || "조회에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const fetchAdminOrders = async () => {
    setError("");
    setAdminLoading(true);

    try {
      const auth = btoa(`${adminId}:${adminPassword}`);
      const response = await fetch(`${API_BASE}/api/admin/orders`, {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "조회 실패");
      setAdminOrders(data);
    } catch (err) {
      setError(err.message || "관리자 조회에 실패했습니다.");
    } finally {
      setAdminLoading(false);
    }
  };

  const markAsPaid = async (orderId) => {
    setError("");
    setAdminLoading(true);
    try {
      const auth = btoa(`${adminId}:${adminPassword}`);
      const response = await fetch(
        `${API_BASE}/api/orders/${orderId}/mark-paid`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
          },
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "승인 실패");
      await fetchAdminOrders();
    } catch (err) {
      setError(err.message || "승인에 실패했습니다.");
    } finally {
      setAdminLoading(false);
    }
  };

  const markAsPending = async (orderId) => {
    setError("");
    setAdminLoading(true);
    try {
      const auth = btoa(`${adminId}:${adminPassword}`);
      const response = await fetch(
        `${API_BASE}/api/orders/${orderId}/mark-pending`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
          },
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "변경 실패");
      await fetchAdminOrders();
    } catch (err) {
      setError(err.message || "변경에 실패했습니다.");
    } finally {
      setAdminLoading(false);
    }
  };

  const markAsPickedUp = async (orderId) => {
    setError("");
    setAdminLoading(true);
    try {
      const auth = btoa(`${adminId}:${adminPassword}`);
      const response = await fetch(
        `${API_BASE}/api/orders/${orderId}/mark-picked-up`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
          },
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "변경 실패");
      await fetchAdminOrders();
    } catch (err) {
      setError(err.message || "변경에 실패했습니다.");
    } finally {
      setAdminLoading(false);
    }
  };

  const markAsNotPickedUp = async (orderId) => {
    setError("");
    setAdminLoading(true);
    try {
      const auth = btoa(`${adminId}:${adminPassword}`);
      const response = await fetch(
        `${API_BASE}/api/orders/${orderId}/mark-not-picked-up`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
          },
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "변경 실패");
      await fetchAdminOrders();
    } catch (err) {
      setError(err.message || "변경에 실패했습니다.");
    } finally {
      setAdminLoading(false);
    }
  };

  const deleteOrder = async (orderId) => {
    setError("");
    setAdminLoading(true);
    try {
      const auth = btoa(`${adminId}:${adminPassword}`);
      const response = await fetch(`${API_BASE}/api/orders/${orderId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${auth}`,
        },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "삭제 실패");
      await fetchAdminOrders();
    } catch (err) {
      setError(err.message || "삭제에 실패했습니다.");
    } finally {
      setAdminLoading(false);
    }
  };

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Dubai</span>
          <span className="brand-sub">쫀득 쿠키 예약</span>
        </div>
        <div className="topbar-actions">
          <button
            className="ghost"
            type="button"
            onClick={() => setView(VIEWS.lookup)}
          >
            주문 조회
          </button>
          <button type="button" onClick={() => setView(VIEWS.order)}>
            주문하기
          </button>
        </div>
      </header>

      <main className="content">
        <section className="hero">
          <p className="eyebrow">Dubai Chewy Cookie</p>
          <h1>오늘 구울 두바이쫀득 쿠키를 예약하세요.</h1>
          <p className="lead">
            오직 지정된 시간에만 픽업 가능해요. 주문 → 계좌이체 → 픽업
            완료 흐름으로 가장 간단하게 운영합니다.
          </p>
          <div className="hero-card">
            <div>
              <p className="label">픽업 장소</p>
              <p className="value">
                {pickupInfo?.location || "픽업 정보를 불러오는 중..."}
              </p>
            </div>
            <div>
              <p className="label">픽업 시간</p>
              <p className="value">
                {pickupInfo?.time || "곧 공개됩니다"}
              </p>
            </div>
            <div>
              <p className="label">오늘 남은 수량</p>
              <p className="value">{remainingText}</p>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>
              {view === VIEWS.order && "주문하기"}
              {view === VIEWS.payment && "결제 안내"}
              {view === VIEWS.complete && "주문 완료"}
              {view === VIEWS.lookup && "주문 조회"}
              {view === VIEWS.admin && "관리자 승인"}
              {view === VIEWS.landing && "이렇게 진행돼요"}
            </h2>
            <p>
              {view === VIEWS.landing &&
                "가장 단순한 예약 흐름만 모았어요. 입금 확인은 수동으로 처리합니다."}
              {view === VIEWS.admin &&
                "입금 확인 대기 주문을 승인하거나 주문 목록을 확인합니다."}
            </p>
          </div>

          {error && <div className="error">{error}</div>}

          {view === VIEWS.landing && (
            <div className="steps">
              <div>
                <span>01</span>
                <p>원하는 수량과 픽업 시간을 선택해 주문합니다.</p>
              </div>
              <div>
                <span>02</span>
                <p>안내된 계좌로 입금하고, 입금자명을 남깁니다.</p>
              </div>
              <div>
                <span>03</span>
                <p>입금 확인 후 픽업 시간에 수령합니다.</p>
              </div>
            </div>
          )}

          {view === VIEWS.order && (
            <form className="form" onSubmit={handleOrderSubmit}>
              <label>
                예약자 이름 (선택)
                <input
                  type="text"
                  value={orderForm.name}
                  onChange={(event) =>
                    setOrderForm((prev) => ({
                      ...prev,
                      name: event.target.value,
                    }))
                  }
                  placeholder="예) 김두바이"
                />
              </label>
              <label>
                연락처
                <input
                  type="tel"
                  required
                  value={orderForm.phone}
                  onChange={(event) =>
                    setOrderForm((prev) => ({
                      ...prev,
                      phone: formatPhoneHint(event.target.value),
                    }))
                  }
                  placeholder="010-1234-5678"
                  maxLength={13}
                  inputMode="tel"
                />
              </label>
              <div className="quantity-field">
                <span>수량</span>
                <div className="quantity-control">
                  <button
                    className="ghost"
                    type="button"
                    onClick={() =>
                      setOrderForm((prev) => ({
                        ...prev,
                        quantity: Math.max(1, prev.quantity - 1),
                      }))
                    }
                    aria-label="수량 감소"
                  >
                    -
                  </button>
                  <input
                    className="quantity-input"
                    type="text"
                    inputMode="numeric"
                    value={orderForm.quantity}
                    onChange={(event) => {
                      const digits = event.target.value.replace(/[^0-9]/g, "");
                      if (digits === "") {
                        setOrderForm((prev) => ({
                          ...prev,
                          quantity: "",
                        }));
                        return;
                      }
                      const next = Math.max(1, Number(digits));
                      setOrderForm((prev) => ({
                        ...prev,
                        quantity: next,
                      }));
                    }}
                    onBlur={() => {
                      setOrderForm((prev) => ({
                        ...prev,
                        quantity:
                          prev.quantity === "" ? 1 : Math.max(1, prev.quantity),
                      }));
                    }}
                    aria-label="수량 입력"
                  />
                  <button
                    className="ghost"
                    type="button"
                    onClick={() =>
                      setOrderForm((prev) => ({
                        ...prev,
                        quantity: prev.quantity + 1,
                      }))
                    }
                    aria-label="수량 증가"
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="price-row">
                <span>단가</span>
                <strong>{formatPrice(PRICE)}원</strong>
              </div>
              <div className="price-row">
                <span>수량</span>
                <strong>{orderForm.quantity}개</strong>
              </div>
              <div className="price-row total">
                <span>총액</span>
                <strong>
                  {formatPrice(PRICE * orderForm.quantity)}원
                </strong>
              </div>
              <button
                className="primary"
                type="submit"
                disabled={loading || isSoldOut || exceedsRemaining}
              >
                {loading ? "주문 중..." : "주문 확정하기"}
              </button>
              {isSoldOut && (
                <p className="soldout">오늘 주문이 마감되었습니다.</p>
              )}
              {!isSoldOut && exceedsRemaining && (
                <p className="soldout">
                  남은 수량보다 많은 주문은 받을 수 없어요.
                </p>
              )}
            </form>
          )}

          {view === VIEWS.payment && orderData && (
            <div className="payment">
              <div className="payment-card">
                <h3>입금 안내</h3>
                <p>
                  아래 계좌로 <strong>30분 내 입금</strong> 부탁드려요.
                </p>
                <div className="account">
                  <div>
                    <span>은행</span>
                    <strong>{ACCOUNT_INFO.bank}</strong>
                  </div>
                  <div>
                    <span>계좌번호</span>
                    <strong>{ACCOUNT_INFO.number}</strong>
                  </div>
                  <div>
                    <span>예금주</span>
                    <strong>{ACCOUNT_INFO.holder}</strong>
                  </div>
                </div>
                <p className="hint">
                  입금자명: <strong>{orderData.depositorName}</strong>
                </p>
                <p className="warning">
                  입금자명은 반드시 위와 동일하게 입력해주세요. 한 글자라도
                  틀리면 확인이 지연됩니다.
                </p>
              </div>
              <div className="payment-card light">
                <h3>주문 정보</h3>
                <p>주문번호: {orderData.code}</p>
                <p>수량: {orderData.quantity}개</p>
                <p>단가: {formatPrice(PRICE)}원</p>
                <p>
                  총액: {formatPrice(PRICE * orderData.quantity)}원
                </p>
                <p>픽업 시간: {orderData.pickupSlot || pickupInfo?.time}</p>
                <p>
                  상태: (
                  <span className={statusClassName(orderData.status)}>
                    {statusLabel}
                  </span>
                  )
                </p>
              </div>
              <button
                className="primary"
                type="button"
                onClick={() => setView(VIEWS.complete)}
              >
                입금 안내 확인했어요
              </button>
            </div>
          )}

          {view === VIEWS.complete && orderData && (
            <div className="complete">
              <div className="complete-card">
                <h3>주문이 접수되었습니다.</h3>
                <p>주문번호는 꼭 기억해주세요. 조회 시 반드시 필요합니다.</p>
                <div className="order-code">{orderData.code}</div>
                <p>
                  결제 금액: {formatPrice(PRICE * orderData.quantity)}원
                </p>
                <p>
                  픽업: {orderData.pickupSlot || pickupInfo?.time} /{" "}
                  {pickupInfo?.location || "픽업 장소 확인 중"}
                </p>
                <p className="status">
                  상태: (
                  <span className={statusClassName(orderData.status)}>
                    {statusLabel}
                  </span>
                  )
                </p>
              </div>
              <button
                className="ghost"
                type="button"
                onClick={() => setView(VIEWS.lookup)}
              >
                주문 조회로 이동
              </button>
            </div>
          )}

          {view === VIEWS.lookup && (
            <div className="lookup">
              <form className="form" onSubmit={handleLookupSubmit}>
                <label>
                  주문번호
                  <input
                    type="text"
                    required
                    value={lookupForm.code}
                    onChange={(event) =>
                      setLookupForm((prev) => ({
                        ...prev,
                        code: event.target.value,
                      }))
                    }
                    placeholder="DUBAI-0001"
                  />
                </label>
                <label>
                  연락처
                  <input
                    type="tel"
                    required
                    value={lookupForm.phone}
                    onChange={(event) =>
                      setLookupForm((prev) => ({
                        ...prev,
                        phone: formatPhoneHint(event.target.value),
                      }))
                    }
                    placeholder="010-1234-5678"
                    maxLength={13}
                    inputMode="tel"
                  />
                </label>
                <button className="primary" type="submit" disabled={loading}>
                  {loading ? "조회 중..." : "주문 조회"}
                </button>
              </form>

              {lookupResult && (
                <div className="lookup-result">
                  <h3>조회 결과</h3>
                  <p>주문번호: {lookupResult.code}</p>
                  <p>수량: {lookupResult.quantity}개</p>
                  <p>
                    결제 금액:{" "}
                    {formatPrice(PRICE * lookupResult.quantity)}원
                  </p>
                  <p>픽업 시간: {lookupResult.pickupSlot || pickupInfo?.time}</p>
                  <p>
                    상태:{" "}
                    <span className={statusClassName(lookupResult.status)}>
                      {STATUS_LABELS[lookupResult.status] ||
                        lookupResult.status}
                    </span>
                  </p>
                </div>
              )}
            </div>
          )}

          {view === VIEWS.admin && (
            <div className="admin">
              <div className="admin-auth">
                <div className="admin-auth-card">
                  <div className="admin-auth-header">
                    <h3>관리자 인증</h3>
                    <p>입금 확인을 위해 관리자 계정을 입력하세요.</p>
                  </div>
                  <div className="admin-auth-fields">
                    <label>
                      관리자 아이디
                      <input
                        type="text"
                        value={adminId}
                        onChange={(event) => setAdminId(event.target.value)}
                        placeholder="아이디"
                      />
                    </label>
                    <label>
                      관리자 비밀번호
                      <input
                        type="password"
                        value={adminPassword}
                        onChange={(event) => setAdminPassword(event.target.value)}
                        placeholder="비밀번호"
                      />
                    </label>
                  </div>
                  <button
                    className="primary"
                    type="button"
                    onClick={fetchAdminOrders}
                    disabled={adminLoading || !adminId || !adminPassword}
                  >
                    {adminLoading ? "불러오는 중..." : "주문 목록 불러오기"}
                  </button>
                </div>
              </div>

              <div className="admin-list">
                {adminOrders.length === 0 && (
                  <p className="empty">표시할 주문이 없습니다.</p>
                )}
                {adminOrders.map((order) => (
                  <div className="admin-card" key={order.id}>
                    <div>
                      <h3>{order.code}</h3>
                      {order.name && <p>예약자: {order.name}</p>}
                      <p>
                        {order.quantity}개 / {order.pickupSlot || pickupInfo?.time}
                      </p>
                      <p>
                        총액: {formatPrice(PRICE * order.quantity)}원
                      </p>
                      <p>입금자명: {order.depositorName}</p>
                      <p>연락처: {order.phone}</p>
                    </div>
                    <div className="admin-actions">
                      <span className={statusClassName(order.status)}>
                        {STATUS_LABELS[order.status] || order.status}
                      </span>
                      <label className="paid-toggle">
                        <input
                          type="checkbox"
                          checked={
                            order.status === "paid" ||
                            order.status === "picked_up"
                          }
                          disabled={adminLoading}
                          onChange={(event) =>
                            event.target.checked
                              ? markAsPaid(order.id)
                              : markAsPending(order.id)
                          }
                        />
                        입금 확인
                      </label>
                      <label className="paid-toggle">
                        <input
                          type="checkbox"
                          checked={order.status === "picked_up"}
                          disabled={
                            adminLoading ||
                            !(
                              order.status === "paid" ||
                              order.status === "picked_up"
                            )
                          }
                          onChange={(event) =>
                            event.target.checked
                              ? markAsPickedUp(order.id)
                              : markAsNotPickedUp(order.id)
                          }
                        />
                        픽업 완료
                      </label>
                      <button
                        className="danger"
                        type="button"
                        disabled={adminLoading}
                        onClick={() => setConfirmDeleteId(order.id)}
                      >
                        주문 삭제
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        <p>운영 문의: 010-0000-0000 / Instagram @dubai_cookie</p>
      </footer>

      {confirmDeleteId !== null && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h3>주문을 삭제할까요?</h3>
            <p>삭제하면 복구할 수 없습니다. 진행하시겠습니까?</p>
            <div className="modal-actions">
              <button
                className="ghost"
                type="button"
                onClick={() => setConfirmDeleteId(null)}
              >
                취소
              </button>
              <button
                className="danger"
                type="button"
                disabled={adminLoading}
                onClick={() => {
                  const targetId = confirmDeleteId;
                  setConfirmDeleteId(null);
                  deleteOrder(targetId);
                }}
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;

const path = require("path");
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const PORT = process.env.PORT || 3001;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "conik";
const ADMIN_USER = process.env.ADMIN_USER || "conik";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "conik7897!";
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 100);

const DB_PATH = path.join(__dirname, "data.sqlite");
const db = new sqlite3.Database(DB_PATH);
const sseClients = new Set();

const PICKUP_INFO = {
  location: "서울특별시 마포구 연남로 10길 12, 1층",
  time: "매일 15:00-20:00",
  note: "현장 픽업만 가능하며, 지정 시간 내 수령해주세요.",
};

db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      phone TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      pickup_slot TEXT NOT NULL,
      depositor_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_payment',
      created_at TEXT NOT NULL
    )`
  );
});

app.use(cors());
app.use(express.json());

const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });

const getTodayCount = async () => {
  const row = await getAsync(
    `SELECT COALESCE(SUM(quantity), 0) as total
     FROM orders
     WHERE date(created_at, 'localtime') = date('now', 'localtime')`
  );
  return row?.total || 0;
};

const broadcastStock = async () => {
  if (sseClients.size === 0) return;
  try {
    const total = await getTodayCount();
    const remaining = Math.max(DAILY_LIMIT - total, 0);
    const payload = JSON.stringify({
      remaining,
      limit: DAILY_LIMIT,
      updatedAt: new Date().toISOString(),
    });
    for (const res of sseClients) {
      res.write(`event: stock\ndata: ${payload}\n\n`);
    }
  } catch (err) {
    // Best-effort; ignore broadcast errors.
  }
};

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });

const toOrderCode = (id) => `DUBAI-${String(id).padStart(4, "0")}`;

const isAdmin = (req) => {
  const token = req.header("x-admin-token");
  if (token && token === ADMIN_TOKEN) return true;

  const auth = req.header("authorization") || "";
  if (!auth.startsWith("Basic ")) return false;

  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const [user, pass] = decoded.split(":");
  return user === ADMIN_USER && pass === ADMIN_PASSWORD;
};

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/pickup-info", (req, res) => {
  getTodayCount()
    .then((total) => {
      const remaining = Math.max(DAILY_LIMIT - total, 0);
      res.json({ ...PICKUP_INFO, limit: DAILY_LIMIT, remaining });
    })
    .catch(() =>
      res.status(500).json({ error: "픽업 정보를 불러오지 못했습니다." })
    );
});

app.post("/api/orders", async (req, res) => {
  const { name, phone, quantity, depositorName } = req.body || {};

  if (!phone || !depositorName) {
    return res.status(400).json({ error: "필수 항목을 확인해주세요." });
  }

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ error: "수량을 확인해주세요." });
  }

  const createdAt = new Date().toISOString();

  try {
    const total = await getTodayCount();
    if (total + qty > DAILY_LIMIT) {
      return res.status(400).json({
        error: "오늘 주문 가능한 수량이 초과되었습니다.",
        remaining: Math.max(DAILY_LIMIT - total, 0),
      });
    }

    const result = await runAsync(
      `INSERT INTO orders (name, phone, quantity, pickup_slot, depositor_name, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending_payment', ?)`,
      [name || null, phone, qty, PICKUP_INFO.time, depositorName, createdAt]
    );

    const id = result.lastID;
    const remaining = Math.max(DAILY_LIMIT - (total + qty), 0);
    res.status(201).json({
      id,
      code: toOrderCode(id),
      name: name || "",
      phone,
      quantity: qty,
      pickupSlot: PICKUP_INFO.time,
      depositorName,
      status: "pending_payment",
      createdAt,
      pickupInfo: { ...PICKUP_INFO, limit: DAILY_LIMIT, remaining },
    });
    broadcastStock();
  } catch (err) {
    res.status(500).json({ error: "주문 저장에 실패했습니다." });
  }
});

app.get("/api/orders/lookup", async (req, res) => {
  const { phone, code } = req.query || {};

  if (!phone || !code) {
    return res.status(400).json({ error: "조회 정보를 확인해주세요." });
  }

  const match = String(code).match(/DUBAI-(\d+)/i);
  const id = match ? Number(match[1]) : Number(code);

  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "주문번호를 확인해주세요." });
  }

  try {
    const order = await getAsync(
      `SELECT * FROM orders WHERE id = ? AND phone = ?`,
      [id, phone]
    );

    if (!order) {
      return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
    }

    res.json({
      id: order.id,
      code: toOrderCode(order.id),
      name: order.name || "",
      phone: order.phone,
      quantity: order.quantity,
      pickupSlot: order.pickup_slot,
      depositorName: order.depositor_name,
      status: order.status,
      createdAt: order.created_at,
      pickupInfo: PICKUP_INFO,
    });
  } catch (err) {
    res.status(500).json({ error: "주문 조회에 실패했습니다." });
  }
});

app.post("/api/orders/:id/mark-paid", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "인증이 필요합니다." });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "주문번호를 확인해주세요." });
  }

  try {
    const result = await runAsync(
      `UPDATE orders SET status = 'paid' WHERE id = ?`,
      [id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
    }
    res.json({ ok: true });
    broadcastStock();
  } catch (err) {
    res.status(500).json({ error: "상태 변경에 실패했습니다." });
  }
});

app.post("/api/orders/:id/mark-pending", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "인증이 필요합니다." });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "주문번호를 확인해주세요." });
  }

  try {
    const result = await runAsync(
      `UPDATE orders SET status = 'pending_payment' WHERE id = ?`,
      [id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
    }
    res.json({ ok: true });
    broadcastStock();
  } catch (err) {
    res.status(500).json({ error: "상태 변경에 실패했습니다." });
  }
});

app.post("/api/orders/:id/mark-picked-up", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "인증이 필요합니다." });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "주문번호를 확인해주세요." });
  }

  try {
    const result = await runAsync(
      `UPDATE orders SET status = 'picked_up' WHERE id = ?`,
      [id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
    }
    res.json({ ok: true });
    broadcastStock();
  } catch (err) {
    res.status(500).json({ error: "상태 변경에 실패했습니다." });
  }
});

app.post("/api/orders/:id/mark-not-picked-up", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "인증이 필요합니다." });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "주문번호를 확인해주세요." });
  }

  try {
    const result = await runAsync(
      `UPDATE orders SET status = 'paid' WHERE id = ?`,
      [id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
    }
    res.json({ ok: true });
    broadcastStock();
  } catch (err) {
    res.status(500).json({ error: "상태 변경에 실패했습니다." });
  }
});

app.delete("/api/orders/:id", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "인증이 필요합니다." });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "주문번호를 확인해주세요." });
  }

  try {
    const result = await runAsync(`DELETE FROM orders WHERE id = ?`, [id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: "주문을 찾을 수 없습니다." });
    }
    res.json({ ok: true });
    broadcastStock();
  } catch (err) {
    res.status(500).json({ error: "주문 삭제에 실패했습니다." });
  }
});

app.get("/api/stock-stream", async (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders?.();

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });

  const total = await getTodayCount();
  const remaining = Math.max(DAILY_LIMIT - total, 0);
  res.write(
    `event: stock\ndata: ${JSON.stringify({
      remaining,
      limit: DAILY_LIMIT,
      updatedAt: new Date().toISOString(),
    })}\n\n`
  );
});

app.get("/api/admin/orders", async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: "인증이 필요합니다." });
  }

  try {
    const rows = await allAsync(
      `SELECT * FROM orders ORDER BY datetime(created_at) DESC LIMIT 200`
    );
    res.json(
      rows.map((order) => ({
        id: order.id,
        code: toOrderCode(order.id),
        name: order.name || "",
        phone: order.phone,
        quantity: order.quantity,
        pickupSlot: order.pickup_slot,
        depositorName: order.depositor_name,
        status: order.status,
        createdAt: order.created_at,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: "주문 목록을 불러오지 못했습니다." });
  }
});

app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});

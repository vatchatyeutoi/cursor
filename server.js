const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const expressLayouts = require('express-ejs-layouts');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function readJson(filePath, fallback) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function formatCurrency(amount) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

function ensureDataFiles() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(PRODUCTS_FILE)) {
    writeJson(PRODUCTS_FILE, []);
  }
  if (!fs.existsSync(ORDERS_FILE)) {
    writeJson(ORDERS_FILE, []);
  }
  if (!fs.existsSync(USERS_FILE)) {
    writeJson(USERS_FILE, []);
  }
}

ensureDataFiles();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 },
  })
);

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

app.use((req, res, next) => {
  // Make cart, helpers, query available
  if (!req.session.cart) {
    req.session.cart = [];
  }
  const cartItemCount = req.session.cart.reduce((sum, item) => sum + item.quantity, 0);
  res.locals.cartItemCount = cartItemCount;
  res.locals.formatCurrency = formatCurrency;
  res.locals.query = req.query || {};

  // Flash messages
  res.locals.flash = req.session.flash;
  delete req.session.flash;

  // Current user
  const users = readJson(USERS_FILE, []);
  const currentUser = users.find((u) => u.id === req.session.userId) || null;
  res.locals.currentUser = currentUser;

  next();
});

function findProductById(products, id) {
  return products.find((p) => p.id === id);
}

function getCartDetailed(products, cart) {
  const items = cart
    .map((ci) => {
      const product = findProductById(products, ci.productId);
      if (!product) return null;
      const subtotal = product.price * ci.quantity;
      return {
        productId: ci.productId,
        name: product.name,
        price: product.price,
        image: product.image,
        quantity: ci.quantity,
        subtotal,
      };
    })
    .filter(Boolean);
  const total = items.reduce((sum, it) => sum + it.subtotal, 0);
  return { items, total };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    setFlash(req, 'error', 'Vui lòng đăng nhập để tiếp tục.');
    const nextUrl = encodeURIComponent(req.originalUrl || '/');
    return res.redirect(`/auth/login?next=${nextUrl}`);
  }
  next();
}

app.get('/', (req, res) => {
  const products = readJson(PRODUCTS_FILE, []);
  const q = (req.query.q || '').toString().trim().toLowerCase();
  const filtered = q
    ? products.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
    : products;
  res.render('index', { products: filtered, q, title: 'Sản phẩm' });
});

app.get('/product/:id', (req, res) => {
  const products = readJson(PRODUCTS_FILE, []);
  const product = findProductById(products, req.params.id);
  if (!product) {
    return res.status(404).send('Sản phẩm không tồn tại');
  }
  res.render('product', { product, title: product.name });
});

app.get('/cart', (req, res) => {
  const products = readJson(PRODUCTS_FILE, []);
  const cart = req.session.cart || [];
  const detailed = getCartDetailed(products, cart);
  res.render('cart', { cart: detailed, title: 'Giỏ hàng' });
});

app.post('/cart/add', (req, res) => {
  const { productId } = req.body;
  let quantity = parseInt(req.body.quantity, 10);
  if (Number.isNaN(quantity) || quantity <= 0) quantity = 1;

  const products = readJson(PRODUCTS_FILE, []);
  const product = findProductById(products, productId);
  if (!product) {
    return res.status(400).send('Sản phẩm không hợp lệ');
  }

  const existing = req.session.cart.find((it) => it.productId === productId);
  if (existing) {
    existing.quantity += quantity;
  } else {
    req.session.cart.push({ productId, quantity });
  }
  setFlash(req, 'success', 'Đã thêm sản phẩm vào giỏ hàng.');
  res.redirect('/cart');
});

app.post('/cart/update', (req, res) => {
  const { productId } = req.body;
  let quantity = parseInt(req.body.quantity, 10);
  if (Number.isNaN(quantity) || quantity < 0) quantity = 0;

  const idx = req.session.cart.findIndex((it) => it.productId === productId);
  if (idx >= 0) {
    if (quantity === 0) {
      req.session.cart.splice(idx, 1);
    } else {
      req.session.cart[idx].quantity = quantity;
    }
  }
  setFlash(req, 'success', 'Cập nhật giỏ hàng thành công.');
  res.redirect('/cart');
});

app.post('/cart/remove', (req, res) => {
  const { productId } = req.body;
  req.session.cart = (req.session.cart || []).filter((it) => it.productId !== productId);
  setFlash(req, 'success', 'Đã xóa sản phẩm khỏi giỏ hàng.');
  res.redirect('/cart');
});

app.get('/checkout', requireAuth, (req, res) => {
  const products = readJson(PRODUCTS_FILE, []);
  const detailed = getCartDetailed(products, req.session.cart || []);
  if (detailed.items.length === 0) {
    return res.redirect('/cart');
  }
  res.render('checkout', { errors: {}, form: { name: '', email: '', address: '' }, cart: detailed, title: 'Thanh toán' });
});

app.post('/checkout', requireAuth, (req, res) => {
  const { name, email, address } = req.body;
  const errors = {};
  if (!name || name.trim().length < 2) errors.name = 'Vui lòng nhập tên';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Email không hợp lệ';
  if (!address || address.trim().length < 5) errors.address = 'Vui lòng nhập địa chỉ';

  const products = readJson(PRODUCTS_FILE, []);
  const detailed = getCartDetailed(products, req.session.cart || []);

  if (detailed.items.length === 0) {
    return res.redirect('/cart');
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).render('checkout', { errors, form: { name, email, address }, cart: detailed, title: 'Thanh toán' });
  }

  const orders = readJson(ORDERS_FILE, []);
  const order = {
    id: uuidv4(),
    createdAt: new Date().toISOString(),
    userId: req.session.userId || null,
    customer: { name, email, address },
    items: detailed.items,
    total: detailed.total,
  };
  orders.push(order);
  writeJson(ORDERS_FILE, orders);

  req.session.cart = [];
  setFlash(req, 'success', 'Đặt hàng thành công! Cảm ơn bạn.');
  res.redirect('/');
});

// Authentication routes
app.get('/auth/register', (req, res) => {
  res.render('auth/register', { title: 'Đăng ký', errors: {}, form: { name: '', email: '', password: '', confirmPassword: '' } });
});

app.post('/auth/register', async (req, res) => {
  const { name, email, password, confirmPassword } = req.body;
  const form = { name: name || '', email: email || '', password: '', confirmPassword: '' };
  const errors = {};

  if (!name || name.trim().length < 2) errors.name = 'Tên tối thiểu 2 ký tự';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Email không hợp lệ';
  if (!password || password.length < 6) errors.password = 'Mật khẩu tối thiểu 6 ký tự';
  if (password !== confirmPassword) errors.confirmPassword = 'Mật khẩu nhập lại không khớp';

  const users = readJson(USERS_FILE, []);
  const existing = users.find((u) => u.email.toLowerCase() === (email || '').toLowerCase());
  if (existing) {
    errors.email = 'Email đã được sử dụng';
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).render('auth/register', { title: 'Đăng ký', errors, form });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  writeJson(USERS_FILE, users);

  req.session.userId = user.id;
  setFlash(req, 'success', 'Đăng ký thành công!');
  res.redirect('/');
});

app.get('/auth/login', (req, res) => {
  const nextUrl = (req.query.next || '/').toString();
  res.render('auth/login', { title: 'Đăng nhập', errors: {}, form: { email: '', password: '', next: nextUrl } });
});

app.post('/auth/login', async (req, res) => {
  const { email, password, next } = req.body;
  const users = readJson(USERS_FILE, []);
  const user = users.find((u) => u.email.toLowerCase() === (email || '').toLowerCase());

  if (!user) {
    return res.status(400).render('auth/login', { title: 'Đăng nhập', errors: { email: 'Email hoặc mật khẩu không đúng' }, form: { email, password: '', next: next || '/' } });
  }

  const ok = await bcrypt.compare(password || '', user.passwordHash);
  if (!ok) {
    return res.status(400).render('auth/login', { title: 'Đăng nhập', errors: { email: 'Email hoặc mật khẩu không đúng' }, form: { email, password: '', next: next || '/' } });
  }

  req.session.userId = user.id;
  setFlash(req, 'success', 'Đăng nhập thành công!');
  const redirectTo = next && typeof next === 'string' ? next : '/';
  res.redirect(redirectTo);
});

app.post('/auth/logout', (req, res) => {
  req.session.userId = null;
  setFlash(req, 'success', 'Đã đăng xuất.');
  res.redirect('/');
});

// Orders page for current user
app.get('/orders', requireAuth, (req, res) => {
  const orders = readJson(ORDERS_FILE, []);
  const myOrders = orders.filter((o) => o.userId === req.session.userId);
  res.render('orders', { title: 'Đơn hàng của tôi', orders: myOrders });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const expressLayouts = require('express-ejs-layouts');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

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

app.use((req, res, next) => {
  if (!req.session.cart) {
    req.session.cart = [];
  }
  const cartItemCount = req.session.cart.reduce((sum, item) => sum + item.quantity, 0);
  res.locals.cartItemCount = cartItemCount;
  res.locals.formatCurrency = formatCurrency;
  res.locals.query = req.query || {};
  next();
});

function findProductById(products, id) {
  return products.find((p) => p.id === id);
}

function getCartDetailed(products, cart) {
  const items = [];
  const validCart = [];

  for (const ci of cart) {
    const product = findProductById(products, ci.productId);
    if (!product) continue;

    const subtotal = product.price * ci.quantity;
    items.push({
      productId: ci.productId,
      name: product.name,
      price: product.price,
      image: product.image,
      quantity: ci.quantity,
      subtotal,
    });
    validCart.push(ci);
  }

  // Remove invalid items from the original cart to keep the session consistent
  cart.length = 0;
  cart.push(...validCart);

  const total = items.reduce((sum, it) => sum + it.subtotal, 0);
  return { items, total };
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
  const detailed = getCartDetailed(products, req.session.cart);
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
  res.redirect('/cart');
});

app.post('/cart/remove', (req, res) => {
  const { productId } = req.body;
  req.session.cart = req.session.cart.filter((it) => it.productId !== productId);
  res.redirect('/cart');
});

app.get('/checkout', (req, res) => {
  const products = readJson(PRODUCTS_FILE, []);
  const detailed = getCartDetailed(products, req.session.cart);
  if (detailed.items.length === 0) {
    return res.redirect('/cart');
  }
  res.render('checkout', {
    errors: {},
    form: { name: '', email: '', address: '' },
    cart: detailed,
    title: 'Thanh toán',
  });
});

app.post('/checkout', (req, res) => {
  const { name, email, address } = req.body;
  const errors = {};
  if (!name || name.trim().length < 2) errors.name = 'Vui lòng nhập tên';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Email không hợp lệ';
  if (!address || address.trim().length < 5) errors.address = 'Vui lòng nhập địa chỉ';

  const products = readJson(PRODUCTS_FILE, []);
  const detailed = getCartDetailed(products, req.session.cart);

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
    customer: { name, email, address },
    items: detailed.items,
    total: detailed.total,
  };
  orders.push(order);
  writeJson(ORDERS_FILE, orders);

  req.session.cart = [];
  res.redirect('/?success=1');
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

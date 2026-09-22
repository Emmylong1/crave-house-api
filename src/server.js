import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const app = express();
const port = Number(process.env.PORT || 4000);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const origins = process.env.WEB_ORIGIN
  ? process.env.WEB_ORIGIN.split(',').map(value => value.trim())
  : true;

app.use(helmet());
app.use(cors({ origin: origins, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

const productSchema = z.object({
  name: z.string().min(2),
  slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
  category_id: z.string().uuid().nullable().optional(),
  description: z.string().max(1000).optional().nullable(),
  price: z.coerce.number().nonnegative(),
  image_url: z.string().url().optional().nullable(),
  is_available: z.boolean().optional(),
  is_featured: z.boolean().optional(),
});

const categorySchema = z.object({
  name: z.string().min(2),
  description: z.string().max(500).optional().nullable(),
  image_url: z.string().url().optional().nullable(),
  sort_order: z.coerce.number().int().default(0),
  is_active: z.boolean().default(true),
});

const orderSchema = z.object({
  order_type: z.enum(['delivery', 'takeaway', 'dine_in']),
  payment_method: z.enum(['cash_on_delivery', 'pay_on_pickup', 'card']).default('cash_on_delivery'),
  customer_name: z.string().min(2),
  customer_phone: z.string().min(7),
  delivery_address_id: z.string().uuid().nullable().optional(),
  notes: z.string().max(500).optional(),
  items: z.array(z.object({
    product_id: z.string().uuid(),
    quantity: z.number().int().positive(),
  })).min(1),
});

async function requireUser(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user = data.user;
  next();
}

async function requireAdmin(req, res, next) {
  const { data, error } = await supabase
    .from('profiles')
    .select('role,full_name')
    .eq('id', req.user.id)
    .single();

  if (error || data?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  req.profile = data;
  next();
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'crave-house-api', timestamp: new Date().toISOString() });
});

app.get('/api/auth/me', requireUser, asyncRoute(async (req, res) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('id,full_name,phone,role,created_at')
    .eq('id', req.user.id)
    .maybeSingle();

  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      email_confirmed_at: req.user.email_confirmed_at,
    },
    profile: profile || null,
  });
}));

app.get('/api/categories', asyncRoute(async (_req, res) => {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('is_active', true)
    .order('sort_order');
  if (error) throw error;
  res.json(data);
}));

app.get('/api/products', asyncRoute(async (req, res) => {
  let query = supabase
    .from('products')
    .select('*, categories(name)')
    .eq('is_available', true)
    .order('created_at', { ascending: false });
  if (req.query.category) query = query.eq('category_id', req.query.category);
  if (req.query.featured === 'true') query = query.eq('is_featured', true);
  const { data, error } = await query;
  if (error) throw error;
  res.json(data);
}));

app.get('/api/products/:id', asyncRoute(async (req, res) => {
  const { data, error } = await supabase
    .from('products')
    .select('*, categories(name)')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Product not found' });
  res.json(data);
}));

app.post('/api/orders', requireUser, asyncRoute(async (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const ids = [...new Set(parsed.data.items.map(item => item.product_id))];
  const { data: products, error: productError } = await supabase
    .from('products')
    .select('id,name,price,is_available')
    .in('id', ids);
  if (productError) throw productError;

  if (products.length !== ids.length || products.some(product => !product.is_available)) {
    return res.status(400).json({ error: 'One or more products are unavailable' });
  }

  const items = parsed.data.items.map(item => {
    const product = products.find(value => value.id === item.product_id);
    return {
      ...item,
      product_name: product.name,
      unit_price: product.price,
      line_total: Number(product.price) * item.quantity,
    };
  });

  const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
  const deliveryFee = parsed.data.order_type === 'delivery'
    ? Number(process.env.DEFAULT_DELIVERY_FEE || 0)
    : 0;
  const orderNumber = `CH-${Date.now().toString().slice(-8)}`;
  const paymentStatus = parsed.data.payment_method === 'card' ? 'pending' : 'unpaid';

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({
      user_id: req.user.id,
      order_number: orderNumber,
      order_type: parsed.data.order_type,
      status: 'pending',
      subtotal,
      delivery_fee: deliveryFee,
      total: subtotal + deliveryFee,
      payment_method: parsed.data.payment_method,
      payment_status: paymentStatus,
      delivery_address_id: parsed.data.delivery_address_id || null,
      customer_name: parsed.data.customer_name,
      customer_phone: parsed.data.customer_phone,
      notes: parsed.data.notes || null,
    })
    .select()
    .single();

  if (orderError) throw orderError;

  const { error: itemError } = await supabase
    .from('order_items')
    .insert(items.map(item => ({ ...item, order_id: order.id })));

  if (itemError) {
    await supabase.from('orders').delete().eq('id', order.id);
    throw itemError;
  }

  res.status(201).json({ ...order, items });
}));

app.get('/api/orders', requireUser, asyncRoute(async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*)')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  res.json(data);
}));

app.use('/api/admin', requireUser, requireAdmin);

app.get('/api/admin/categories', asyncRoute(async (_req, res) => {
  const { data, error } = await supabase.from('categories').select('*').order('sort_order');
  if (error) throw error;
  res.json(data);
}));

app.post('/api/admin/categories', asyncRoute(async (req, res) => {
  const parsed = categorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { data, error } = await supabase.from('categories').insert(parsed.data).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

app.patch('/api/admin/categories/:id', asyncRoute(async (req, res) => {
  const parsed = categorySchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { data, error } = await supabase.from('categories').update(parsed.data).eq('id', req.params.id).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

app.delete('/api/admin/categories/:id', asyncRoute(async (req, res) => {
  const { error } = await supabase.from('categories').update({ is_active: false }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).end();
}));

app.get('/api/admin/products', asyncRoute(async (_req, res) => {
  const { data, error } = await supabase.from('products').select('*, categories(name)').order('created_at', { ascending: false });
  if (error) throw error;
  res.json(data);
}));

app.post('/api/admin/products', asyncRoute(async (req, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { data, error } = await supabase.from('products').insert(parsed.data).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.status(201).json(data);
}));

app.patch('/api/admin/products/:id', asyncRoute(async (req, res) => {
  const parsed = productSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { data, error } = await supabase
    .from('products')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

app.delete('/api/admin/products/:id', asyncRoute(async (req, res) => {
  const { error } = await supabase.from('products').update({ is_available: false }).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.status(204).end();
}));

app.get('/api/admin/orders', asyncRoute(async (_req, res) => {
  const { data, error } = await supabase.from('orders').select('*, order_items(*)').order('created_at', { ascending: false });
  if (error) throw error;
  res.json(data);
}));

app.patch('/api/admin/orders/:id/status', asyncRoute(async (req, res) => {
  const allowed = ['pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'Invalid order status' });
  const { data, error } = await supabase
    .from('orders')
    .update({ status: req.body.status, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

app.patch('/api/admin/orders/:id/payment', asyncRoute(async (req, res) => {
  const allowed = ['unpaid', 'pending', 'paid', 'failed', 'refunded'];
  if (!allowed.includes(req.body.payment_status)) return res.status(400).json({ error: 'Invalid payment status' });
  const { data, error } = await supabase
    .from('orders')
    .update({ payment_status: req.body.payment_status, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(port, () => console.log(`Crave House API listening on ${port}`));

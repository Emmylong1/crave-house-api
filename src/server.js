import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const app = express();
const port = Number(process.env.PORT || 4000);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN?.split(',') || '*', credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(morgan('combined'));

const productSchema = z.object({
  name: z.string().min(2), slug: z.string().min(2), category_id: z.string().uuid().nullable().optional(),
  description: z.string().max(1000).optional().nullable(), price: z.coerce.number().nonnegative(),
  image_url: z.string().url().optional().nullable(), is_available: z.boolean().optional(), is_featured: z.boolean().optional()
});
const orderSchema = z.object({
  order_type: z.enum(['delivery','takeaway','dine_in']), customer_name: z.string().min(2), customer_phone: z.string().min(7),
  delivery_address_id: z.string().uuid().nullable().optional(), notes: z.string().max(500).optional(),
  items: z.array(z.object({ product_id: z.string().uuid(), quantity: z.number().int().positive() })).min(1)
});

async function requireUser(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: 'Invalid session' });
  req.user = data.user; next();
}
async function requireAdmin(req, res, next) {
  const { data, error } = await supabase.from('profiles').select('role').eq('id', req.user.id).single();
  if (error || data?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

app.get('/health', (_req,res)=>res.json({ ok:true, service:'crave-house-api', timestamp:new Date().toISOString() }));
app.get('/api/categories', async (_req,res)=>{ const {data,error}=await supabase.from('categories').select('*').eq('is_active',true).order('sort_order'); if(error)return res.status(500).json({error:error.message}); res.json(data); });
app.get('/api/products', async (req,res)=>{ let q=supabase.from('products').select('*, categories(name)').eq('is_available',true).order('created_at',{ascending:false}); if(req.query.category) q=q.eq('category_id',req.query.category); if(req.query.featured==='true') q=q.eq('is_featured',true); const {data,error}=await q; if(error)return res.status(500).json({error:error.message}); res.json(data); });
app.get('/api/products/:id', async (req,res)=>{ const {data,error}=await supabase.from('products').select('*, categories(name)').eq('id',req.params.id).single(); if(error)return res.status(404).json({error:'Product not found'}); res.json(data); });

app.post('/api/orders', requireUser, async (req,res)=>{
  const parsed=orderSchema.safeParse(req.body); if(!parsed.success)return res.status(400).json({error:parsed.error.flatten()});
  const ids=parsed.data.items.map(i=>i.product_id); const {data:products,error:pe}=await supabase.from('products').select('id,name,price,is_available').in('id',ids);
  if(pe)return res.status(500).json({error:pe.message}); if(products.length!==ids.length || products.some(p=>!p.is_available))return res.status(400).json({error:'One or more products are unavailable'});
  const items=parsed.data.items.map(i=>{const p=products.find(x=>x.id===i.product_id);return {...i,product_name:p.name,unit_price:p.price,line_total:Number(p.price)*i.quantity};});
  const subtotal=items.reduce((s,i)=>s+i.line_total,0); const orderNumber=`CH-${Date.now().toString().slice(-8)}`;
  const {data:order,error:oe}=await supabase.from('orders').insert({user_id:req.user.id,order_number:orderNumber,order_type:parsed.data.order_type,status:'pending',subtotal,total:subtotal,delivery_address_id:parsed.data.delivery_address_id||null,customer_name:parsed.data.customer_name,customer_phone:parsed.data.customer_phone,notes:parsed.data.notes||null}).select().single();
  if(oe)return res.status(500).json({error:oe.message}); const {error:ie}=await supabase.from('order_items').insert(items.map(i=>({...i,order_id:order.id}))); if(ie){await supabase.from('orders').delete().eq('id',order.id);return res.status(500).json({error:ie.message});}
  res.status(201).json({...order,items});
});
app.get('/api/orders', requireUser, async (req,res)=>{const {data,error}=await supabase.from('orders').select('*, order_items(*)').eq('user_id',req.user.id).order('created_at',{ascending:false});if(error)return res.status(500).json({error:error.message});res.json(data);});

app.use('/api/admin', requireUser, requireAdmin);
app.get('/api/admin/products', async (_req,res)=>{const {data,error}=await supabase.from('products').select('*, categories(name)').order('created_at',{ascending:false});if(error)return res.status(500).json({error:error.message});res.json(data);});
app.post('/api/admin/products', async (req,res)=>{const p=productSchema.safeParse(req.body);if(!p.success)return res.status(400).json({error:p.error.flatten()});const {data,error}=await supabase.from('products').insert(p.data).select().single();if(error)return res.status(400).json({error:error.message});res.status(201).json(data);});
app.patch('/api/admin/products/:id', async (req,res)=>{const p=productSchema.partial().safeParse(req.body);if(!p.success)return res.status(400).json({error:p.error.flatten()});const {data,error}=await supabase.from('products').update({...p.data,updated_at:new Date().toISOString()}).eq('id',req.params.id).select().single();if(error)return res.status(400).json({error:error.message});res.json(data);});
app.delete('/api/admin/products/:id', async (req,res)=>{const {error}=await supabase.from('products').delete().eq('id',req.params.id);if(error)return res.status(400).json({error:error.message});res.status(204).end();});
app.get('/api/admin/orders', async (_req,res)=>{const {data,error}=await supabase.from('orders').select('*, order_items(*)').order('created_at',{ascending:false});if(error)return res.status(500).json({error:error.message});res.json(data);});
app.patch('/api/admin/orders/:id/status', async (req,res)=>{const allowed=['pending','confirmed','preparing','ready','out_for_delivery','delivered','cancelled'];if(!allowed.includes(req.body.status))return res.status(400).json({error:'Invalid order status'});const {data,error}=await supabase.from('orders').update({status:req.body.status,updated_at:new Date().toISOString()}).eq('id',req.params.id).select().single();if(error)return res.status(400).json({error:error.message});res.json(data);});

app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:'Internal server error'});});
app.listen(port,()=>console.log(`Crave House API listening on ${port}`));

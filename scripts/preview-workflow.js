// Entirely isolated fixtures: this process never loads .env or connects to Atlas.
const express = require('express');
const path = require('node:path');
const {ObjectId}=require('mongodb');
const {memoryDatabase}=require('../test/memory-db.cjs');
const memory=memoryDatabase();
const database=require('../db');database.getDatabase=async()=>memory.db;database.withTransaction=memory.transact;
const day=offset=>{const date=new Date();date.setDate(date.getDate()+offset);return new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()));};
const inventory=[
 {name:'Eggs',quantity:3,unit:'pieces',storage:'fridge',category:'protein',expiryDate:day(-1)},
 {name:'Spinach',quantity:1,unit:'bags',storage:'fridge',category:'fruits_vegetables',expiryDate:day(0)},
 {name:'Carrots',quantity:3,unit:'pieces',storage:'fridge',category:'fruits_vegetables',expiryDate:day(1)},
 {name:'Apple',quantity:2,unit:'pieces',storage:'pantry',category:'fruits_vegetables',expiryDate:day(3)},
 {name:'Milk',quantity:1,unit:'bottles',storage:'fridge',category:'protein',expiryDate:day(4)},
 {name:'Rice',quantity:2,unit:'kg',storage:'pantry',category:'grains',expiryDate:null},
 {name:'Tomatoes',quantity:3,unit:'pieces',storage:'fridge',category:'fruits_vegetables',expiryDate:null},
 {name:'Tomatoes',quantity:1,unit:'bags',storage:'pantry',category:'fruits_vegetables',expiryDate:null}
].map(item=>({_id:new ObjectId(),...item}));
memory.reset({ingredients:inventory,shopping_items:[
 {_id:new ObjectId(),name:'Egg',plannedQuantity:4,unit:'pieces',category:'protein',ingredientId:new ObjectId()},
 {_id:new ObjectId(),name:'Rice',plannedQuantity:1,unit:'bags',category:'grains'},
 {_id:new ObjectId(),name:'Tomato',plannedQuantity:2,unit:'pieces',category:'fruits_vegetables'},
 {_id:new ObjectId(),name:'Unplanned oats',plannedQuantity:2,unit:'packs',category:'other'}
]});
const app=express();
app.get('/__snapshot',(req,res)=>res.json(memory.snapshot()));
app.post('/__fail-purchase/:id',(req,res)=>{memory.failWrite('shopping_items',new ObjectId(req.params.id));res.json({ok:true});});
app.get('/__review',(req,res)=>{
 const width=Math.max(320,Math.min(1440,Number(req.query.width)||390));const height=Math.max(568,Math.min(1100,Number(req.query.height)||844));
 res.type('html').send(`<!doctype html><html><head><title>Workflow review · ${width} × ${height}</title><style>body{margin:0;font:14px system-ui;background:#dce5dc}header,p{padding:8px;margin:0;background:white}a{display:inline-flex;align-items:center;min-height:44px;margin-right:16px;color:#27684e}iframe{display:block;width:${width}px;height:${height}px;border:0;margin:12px auto}</style></head><body><header>Isolated workflow fixtures · <a href="/__review?width=320&height=568">Small phone</a><a href="/__review?width=390&height=844">Phone</a><a href="/__review?width=768&height=1024">Tablet</a><a href="/__review?width=1280&height=800">Desktop</a></header><p id="metrics">Loading…</p><iframe title="Kitchen preview" src="/"></iframe><script>
 const frame=document.querySelector('iframe');function measure(){const d=frame.contentDocument;if(!d?.querySelector('.workspace'))return;const win=frame.contentWindow;const overflow=[...d.querySelectorAll('.workspace,.list-panel,.list-scroll,dialog[open],.sheet-content,.bulk-review-row')].filter(el=>el.getClientRects().length&&el.scrollWidth>el.clientWidth+1);const buttons=[...d.querySelectorAll('button,summary')].filter(el=>el.getClientRects().length);document.querySelector('#metrics').textContent='Horizontal overflow: '+overflow.length+' · Targets under 44px: '+buttons.filter(el=>el.getBoundingClientRect().width<43.9||el.getBoundingClientRect().height<43.9).length+' · Inputs ≥16px: '+[...d.querySelectorAll('input,select')].every(el=>parseFloat(win.getComputedStyle(el).fontSize)>=16)+' · Panel heights: '+[...d.querySelectorAll('.list-scroll')].map(el=>Math.round(el.clientHeight)).join(', ')+' · Settings dialogs: '+d.querySelectorAll('dialog[open]').length+' · Focus: '+(d.activeElement.id||d.activeElement.tagName);}
 frame.addEventListener('load',()=>{new MutationObserver(measure).observe(frame.contentDocument.body,{subtree:true,childList:true,attributes:true});frame.contentDocument.addEventListener('scroll',measure,true);setInterval(measure,1000);});</script></body></html>`);
});
app.use(express.static(path.join(__dirname,'../public')));app.use(require('../app').createApp());
(async()=>{await require('./migrate-categories').migrateCategories(memory.db,memory.transact);await require('./migrate-workflow').migrateWorkflow(memory.db,memory.transact);const server=app.listen(3230,'127.0.0.1',()=>console.log('Isolated workflow preview: http://localhost:3230/__review — memory only.'));process.on('SIGINT',()=>server.close(()=>process.exit(0)));})();

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ObjectId } = require('mongodb');
const db = require('../db');
let rows;
const equal = (a,b) => String(a) === String(b);
function matches(row, filter) {
 return Object.entries(filter).every(([key,value]) => {
  if(key === '$or') return value.some(part => matches(row,part));
  if(value && typeof value === 'object' && !(value instanceof ObjectId)) {
   if('$in' in value) return value.$in.some(v => v === null ? row[key] == null : equal(row[key],v));
   if('$ne' in value) return !equal(row[key],value.$ne);
   if('$regex' in value) return new RegExp(value.$regex,value.$options).test(row[key]);
  }
  return equal(row[key],value);
 });
}
const database = { collection(name) { return {
 find(filter) { const values=rows[name].filter(row=>matches(row,filter));return { sort(){return this;},limit(){return this;},project(){return this;},async toArray(){return values.map(row=>({...row}));} }; },
 async findOne(filter) {return rows[name].find(row=>matches(row,filter)) || null;},
 async insertOne(row) {row._id ||= new ObjectId();rows[name].push({...row});return {insertedId:row._id};},
 async findOneAndUpdate(filter,update) {const row=rows[name].find(row=>matches(row,filter));if(!row)return null;Object.assign(row,update.$set);for(const [key,value] of Object.entries(update.$inc||{}))row[key]+=value;return {...row};},
 async createIndex() {},
 }; } };
db.getDatabase=async()=>database;
db.withTransaction=async work=>work(database,{});
const handler = require('serverless-http')(require('../app').createApp());
async function request(path, method='GET', body) {
 const url = new URL(path,'http://localhost');
 const response=await handler({httpMethod:method,path:url.pathname,queryStringParameters:Object.fromEntries(url.searchParams),headers:{'content-type':'application/json'},body:body===undefined?null:JSON.stringify(body),isBase64Encoded:false},{});
 return {status:response.statusCode,body:JSON.parse(response.body)};
}
const ingredient = {name:'Temporary spinach',quantity:2,unit:'bags',storage:'fridge',expiryDate:null};
function reset() { rows={ingredients:[{...ingredient,_id:new ObjectId(),category:'fruits_vegetables'},{...ingredient,name:'Temporary rice',_id:new ObjectId(),storage:'pantry',category:'grains'},{...ingredient,name:'Legacy uncategorized',_id:new ObjectId()}],shopping_items:[]}; }

test('Category and combined category/name/storage filters return matching records; Other includes missing category without writing it',async()=>{
 reset();
 for(const [query,count] of [['category=fruits_vegetables',1],['category=fruits_vegetables&name=spinach&storage=fridge',1],['category=fruits_vegetables&storage=pantry',0],['category=other',1]]) {
  const result=await request('/api/ingredients?'+query);assert.equal(result.status,200);assert.equal(result.body.count,count);
 }
 const other=await request('/api/ingredients?category=other');assert.equal(other.body.ingredients[0].category,'other');assert.ok(!Object.hasOwn(rows.ingredients[2],'category'));
 for(const category of ['invalid','','%7B%22%24ne%22%3Anull%7D']) assert.equal((await request('/api/ingredients?category='+category)).status,400);
});

test('Create, edit, omitted-category preservation, fallback and fresh reads persist categories',async()=>{
 reset();
 const created=await request('/api/ingredients','POST',{...ingredient,category:'protein'});assert.equal(created.status,201);const path='/api/ingredients/'+created.body._id;
 assert.equal((await request(path,'PUT',{...ingredient,quantity:4})).body.category,'protein');
 assert.equal((await request(path,'PUT',{...ingredient,category:'grains'})).body.category,'grains');
 const fresh=await request('/api/ingredients?category=grains');assert.ok(fresh.body.ingredients.some(row=>row._id===created.body._id));
 assert.equal((await request('/api/ingredients','POST',ingredient)).body.category,'other');
 for(const category of ['fruit','',null,3,{$ne:null}]) for(const [p,m] of [['/api/ingredients','POST'],[path,'PUT']])assert.equal((await request(p,m,{...ingredient,category})).status,400);
});

test('Purchases create selected/fallback categories, preserve existing category, enforce units, and remain idempotent',async()=>{
 reset();
 async function plan(link) {return (await request('/api/shopping-items','POST',{name:'Temporary purchase',plannedQuantity:9,unit:'bags',...(link?{ingredientId:String(link)}:{})})).body;}
 const purchase={quantity:3,unit:'bags',destination:'new',storage:'pantry',category:'grains'};
 const item=await plan();const path='/api/shopping-items/'+item._id+'/purchase';
 const saved=await request(path,'POST',purchase);assert.equal(saved.status,200);assert.equal(saved.body.ingredient.category,'grains');assert.equal(saved.body.shoppingItem.status,'completed');
 assert.equal((await request(path,'POST',purchase)).body.alreadyCompleted,true);
 const linked=await plan(rows.ingredients[0]._id);const linkedPath='/api/shopping-items/'+linked._id+'/purchase';
 assert.equal((await request(linkedPath,'POST',{...purchase,destination:'existing',unit:'kg'})).status,409);
 const combined=await request(linkedPath,'POST',{...purchase,destination:'existing'});assert.equal(combined.status,200);assert.equal(combined.body.ingredient.category,'fruits_vegetables');assert.equal(combined.body.ingredient.quantity,5);
 const fallback=await plan();const {category,...noCategory}=purchase;assert.equal((await request('/api/shopping-items/'+fallback._id+'/purchase','POST',noCategory)).body.ingredient.category,'other');
 const invalid=await plan();assert.equal((await request('/api/shopping-items/'+invalid._id+'/purchase','POST',{...purchase,category:'invalid'})).status,400);
 const fresh=await request('/api/ingredients?category=grains');assert.ok(fresh.body.ingredients.some(row=>row._id===saved.body.ingredient._id));
});

test('Shopping categories persist on create/edit and omission, copy on linking, and validate input', async () => {
 reset();
 const plan = {name:'Shopping category check',plannedQuantity:2,unit:'bags',category:'protein'};
 const created=await request('/api/shopping-items','POST',plan);assert.equal(created.status,201);assert.equal(created.body.category,'protein');
 const path='/api/shopping-items/'+created.body._id;
 const {category,...omitted}=plan;
 assert.equal((await request(path,'PUT',omitted)).body.category,'protein');
 assert.equal((await request(path,'PUT',{...plan,category:'grains'})).body.category,'grains');
 assert.equal((await request('/api/shopping-items?category=grains')).body.shoppingItems[0].category,'grains');
 assert.equal(rows.shopping_items[0].category,'grains');
 for(const invalid of ['',null,3,'invalid',{$ne:null}]) {
  assert.equal((await request('/api/shopping-items','POST',{...plan,category:invalid})).status,400);
  assert.equal((await request(path,'PUT',{...plan,category:invalid})).status,400);
 }
 assert.equal((await request('/api/shopping-items?category=invalid')).status,400);
 const linked=await request('/api/shopping-items','POST',{...omitted,name:rows.ingredients[0].name,ingredientId:String(rows.ingredients[0]._id)});
 assert.equal(linked.body.category,'fruits_vegetables');assert.equal(rows.shopping_items[1].category,'fruits_vegetables');
 const duplicate=await request('/api/shopping-items','POST',{...omitted,ingredientId:String(rows.ingredients[0]._id)});
 assert.equal(duplicate.status,409);assert.equal(duplicate.body.existingItem.category,'fruits_vegetables');
 await request('/api/shopping-items/'+linked.body._id,'PUT',{...plan,category:'protein'});
 assert.equal(rows.ingredients[0].category,'fruits_vegetables');
});

test('Legacy shopping category fallback is consistent in API filtering and leaves records/status unchanged', async () => {
 reset();
 const base={name:'Legacy shopping',plannedQuantity:1,unit:'bags'};
 rows.shopping_items=[
  {...base,_id:new ObjectId(),ingredientId:rows.ingredients[0]._id,status:'completed'},
  {...base,_id:new ObjectId(),ingredientId:rows.ingredients[1]._id},
  {...base,_id:new ObjectId(),ingredientId:rows.ingredients[2]._id},
  {...base,_id:new ObjectId(),ingredientId:new ObjectId()},
  {...base,_id:new ObjectId()},
  {...base,_id:new ObjectId(),ingredientId:rows.ingredients[0]._id,category:'protein'}
 ];
 const before=JSON.stringify(rows);
 const all=await request('/api/shopping-items');assert.deepEqual(all.body.shoppingItems.map(item=>item.category),['fruits_vegetables','grains','other','other','other','protein']);
 for(const category of ['protein','grains','fruits_vegetables','other']) {
  const filtered=await request('/api/shopping-items?category='+category);
  assert.deepEqual(filtered.body.shoppingItems.map(item=>item._id),all.body.shoppingItems.filter(item=>item.category===category).map(item=>item._id));
 }
 assert.equal(JSON.stringify(rows),before);
 const linkedMatches=await request('/api/shopping-items?ingredientId='+rows.ingredients[0]._id+'&category=protein');
 assert.equal(linkedMatches.body.count,1);assert.equal(linkedMatches.body.shoppingItems[0].category,'protein');
});

test('Shopping category defaults new purchases, permits overrides, and never changes existing inventory categories',async()=>{
 reset();const base={name:'Purchase category',plannedQuantity:8,unit:'bags',category:'grains'};
 const purchase={quantity:2,unit:'bags',storage:'fridge',destination:'new'};
 const plan=await request('/api/shopping-items','POST',base);
 const path='/api/shopping-items/'+plan.body._id+'/purchase';
 const saved=await request(path,'POST',purchase);assert.equal(saved.body.ingredient.category,'grains');
 assert.equal(saved.body.shoppingItem.category,'grains');assert.equal(saved.body.shoppingItem.plannedQuantity,8);
 assert.equal((await request(path,'POST',purchase)).body.alreadyCompleted,true);
 const override=await request('/api/shopping-items','POST',base);
 const changed=await request('/api/shopping-items/'+override.body._id+'/purchase','POST',{...purchase,category:'protein'});
 assert.equal(changed.body.ingredient.category,'protein');assert.equal(changed.body.shoppingItem.category,'grains');
 const linked=await request('/api/shopping-items','POST',{...base,ingredientId:String(rows.ingredients[0]._id)});
 const combined=await request('/api/shopping-items/'+linked.body._id+'/purchase','POST',{...purchase,destination:'existing',category:'protein'});
 assert.equal(combined.body.ingredient.category,'fruits_vegetables');assert.equal(combined.body.shoppingItem.category,'grains');
 assert.equal((await request('/api/shopping-items?category=grains')).body.count,3);
 const legacy={_id:new ObjectId(),name:'Legacy purchase',plannedQuantity:1,unit:'bags',ingredientId:rows.ingredients[0]._id};
 rows.shopping_items.push(legacy);
 const inherited=await request('/api/shopping-items/'+legacy._id+'/purchase','POST',purchase);
 assert.equal(inherited.status,200);
 assert.equal(inherited.body.ingredient.category,'fruits_vegetables');
});

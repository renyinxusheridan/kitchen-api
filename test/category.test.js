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

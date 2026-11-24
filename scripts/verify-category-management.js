// Uses a uniquely named disposable database, never kitchen_app.
const assert = require('node:assert/strict');
require('dotenv').config({ quiet: true });
const connectionModule = require('../db');
const { ObjectId, BSON } = require('mongodb');
const databaseName = 'kitchen_category_check_' + Date.now();
const connection = connectionModule.createDatabaseConnection({ env: { ...process.env, DB_NAME: databaseName } });
let failShopping = false;
connectionModule.getDatabase = connection.getDatabase;
connectionModule.withTransaction = work => connection.withTransaction((database,session) => work({ collection(name) {
  const collection = database.collection(name);
  return new Proxy(collection,{get(target,key){
    if (name === 'shopping_items' && key === 'updateMany') return async(...args)=>{ if(failShopping){failShopping=false;throw Error('Injected write failure');}return target.updateMany(...args); };
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
} },session));
const handle = require('serverless-http')(require('../app').createApp());
const {migrateCategories} = require('./migrate-categories');
const {migrateWorkflow} = require('./migrate-workflow');
const {legacy} = require('../categories');
async function request(path,method='GET',body){const url=new URL(path,'http://localhost');const response=await handle({httpMethod:method,path:url.pathname,queryStringParameters:Object.fromEntries(url.searchParams),headers:{'content-type':'application/json'},body:body===undefined?null:JSON.stringify(body),isBase64Encoded:false},{});return{status:response.statusCode,body:response.body?JSON.parse(response.body):null};}
const encode = data => BSON.EJSON.stringify(data,{relaxed:false});
(async()=>{
 const database=await connection.getDatabase();
 assert.notEqual(database.databaseName,'kitchen_app');
 try {
  const base={name:'DISPOSABLE CATEGORY CHECK',quantity:2,unit:'pieces',storage:'fridge',expiryDate:null};
  const seed=[{...base,category:'protein',extra:{preserve:true}},{...base,name:'Legacy Other',category:'other'},{...base,name:'Legacy Missing'}];
  await database.collection('ingredients').insertMany(seed);
  await database.collection('shopping_items').insertMany([{name:base.name,plannedQuantity:2,unit:'pieces',category:'grains',status:'completed',extra:'preserve'},{name:'Legacy shopping',plannedQuantity:1,unit:'pieces',ingredientId:seed[0]._id}]);
  const before={ingredients:await database.collection('ingredients').find({}).toArray(),shopping_items:await database.collection('shopping_items').find({}).toArray()};
  await migrateCategories(database,connection.withTransaction);
  const after={ingredients:await database.collection('ingredients').find({}).toArray(),shopping_items:await database.collection('shopping_items').find({}).toArray()};
  for(const name of ['ingredients','shopping_items'])assert.equal(encode(after[name].map(({categoryId,...row})=>row)),encode(before[name]));
  assert.equal(after.ingredients[0].categoryId.toString(),legacy.protein._id.toString());assert.equal(after.ingredients[1].categoryId,null);assert.equal(after.shopping_items[1].categoryId,null);
  assert.deepEqual(await migrateCategories(database,connection.withTransaction),{ingredients:0,shopping_items:0});
  await migrateWorkflow(database,connection.withTransaction);
  console.log('PASS real MongoDB migration: fields/status preserved, Other/missing => null, rerun changes zero records.');
  const created=await request('/api/categories','POST',{name:'  Snacks  '});assert.equal(created.status,201);const id=created.body._id;
  assert.equal((await request('/api/categories','POST',{name:'sNACKs'})).status,409);
  assert.equal((await request('/api/categories','POST',{name:' '})).status,400);
  const ingredient=await request('/api/ingredients','POST',{...base,categoryId:id});assert.equal(ingredient.status,201);
  const rawBefore=await database.collection('ingredients').findOne({_id:new ObjectId(ingredient.body._id)});
  const shopping=await request('/api/shopping-items','POST',{name:'Dynamic shopping',plannedQuantity:3,unit:'pieces',ingredientId:ingredient.body._id});assert.equal(shopping.body.categoryId,id);
  await request('/api/categories/'+id,'PUT',{name:'Treats'});
  assert.equal(encode(await database.collection('ingredients').findOne({_id:rawBefore._id})),encode(rawBefore));
  assert.equal((await request('/api/ingredients?categoryId='+id+'&name=DISPOSABLE&storage=fridge')).body.count,1);
  assert.equal((await request('/api/shopping-items?categoryId='+id)).body.shoppingItems[0].categoryName,'Treats');
  const grains=String(legacy.grains._id);
  await request('/api/shopping-items/'+shopping.body._id,'PUT',{name:'Dynamic shopping',plannedQuantity:3,unit:'pieces',categoryId:grains});
  const purchased=await request('/api/shopping-items/'+shopping.body._id+'/purchase','POST',{quantity:1,unit:'pieces',destination:'existing',storage:'fridge'});assert.equal(purchased.status,200);assert.equal(purchased.body.ingredient.categoryId,id);assert.equal(purchased.body.shoppingItem.categoryId,grains);
  const newPlan=await request('/api/shopping-items','POST',{name:'New purchase',plannedQuantity:4,unit:'pieces',categoryId:id});
  const purchase={quantity:1.5,unit:'pieces',destination:'new',storage:'pantry'};
  const recorded=await request('/api/shopping-items/'+newPlan.body._id+'/purchase','POST',purchase);assert.equal(recorded.status,200);assert.equal(recorded.body.ingredient.categoryId,id);assert.equal((await request('/api/shopping-items/'+newPlan.body._id+'/purchase','POST',purchase)).body.alreadyCompleted,true);
  console.log('PASS real API create/rename/duplicate/filter/linked copy/edit/purchases and fresh database reads.');
  const detail=(await request('/api/categories/'+id)).body;assert.equal(detail.inventoryCount,2);assert.equal(detail.shoppingCount,1);
  const snapshot=encode({ingredients:await database.collection('ingredients').find({}).toArray(),shopping_items:await database.collection('shopping_items').find({}).toArray()});
  failShopping=true;assert.equal((await request('/api/categories/'+id,'DELETE',detail)).status,500);
  assert.equal(encode({ingredients:await database.collection('ingredients').find({}).toArray(),shopping_items:await database.collection('shopping_items').find({}).toArray()}),snapshot);
  assert.equal((await request('/api/categories/'+id,'DELETE',detail)).status,204);
  assert.equal(await database.collection('ingredients').countDocuments({categoryId:new ObjectId(id)}),0);assert.equal(await database.collection('shopping_items').countDocuments({categoryId:new ObjectId(id)}),0);
  assert.equal((await request('/api/ingredients','POST',{...base,categoryId:id})).status,409);
  console.log('PASS real transaction rollback after injected partial deletion failure; confirmed deletion clears references and retains records.');
  const racing=(await request('/api/categories','POST',{name:'Race check'})).body;
  const results=await Promise.all([request('/api/ingredients','POST',{...base,categoryId:racing._id}),request('/api/categories/'+racing._id,'DELETE',{name:racing.name,inventoryCount:0,shoppingCount:0})]);
  const references=await database.collection('ingredients').countDocuments({categoryId:new ObjectId(racing._id)});
  const category=await database.collection('categories').findOne({_id:new ObjectId(racing._id)});
  assert.ok(category || references===0);assert.ok(results.every(result=>[201,204,409].includes(result.status)));
  console.log('PASS concurrent assignment/deletion leaves no broken references.');
 } finally {
  assert.match(database.databaseName,/^kitchen_category_check_\d+$/);
  await database.dropDatabase();console.log('Disposable verification database removed. Shared kitchen_app was not used.');
 }
})().catch(error=>{console.error('Category verification failed: '+(error.name==='AssertionError'?error.message:connectionModule.connectionErrorMessage(error)));process.exitCode=1;}).finally(connection.close);

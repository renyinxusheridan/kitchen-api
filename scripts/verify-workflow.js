// Real MongoDB integration checks in a disposable database, never kitchen_app.
const assert=require('node:assert/strict');
require('dotenv').config({quiet:true});
const connectionModule=require('../db');
const {ObjectId,BSON}=require('mongodb');
const databaseName='kitchen_workflow_check_'+Date.now();
const connection=connectionModule.createDatabaseConnection({env:{...process.env,DB_NAME:databaseName}});
connectionModule.getDatabase=connection.getDatabase;
let failId;
connectionModule.withTransaction=work=>connection.withTransaction((database,session)=>work({collection(name){const collection=database.collection(name);return new Proxy(collection,{get(target,key){if(name==='shopping_items'&&key==='deleteOne')return async(...args)=>{if(failId&&String(args[0]._id)===failId){failId=null;throw Error('Injected shopping removal failure');}return target.deleteOne(...args);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});}},session));
const handle=require('serverless-http')(require('../app').createApp());
const {migrateCategories}=require('./migrate-categories');const {migrateWorkflow}=require('./migrate-workflow');
async function request(path,method='GET',body){const url=new URL(path,'http://localhost');const response=await handle({httpMethod:method,path:url.pathname,queryStringParameters:Object.fromEntries(url.searchParams),headers:{'content-type':'application/json'},body:body===undefined?null:JSON.stringify(body),isBase64Encoded:false},{});return{status:response.statusCode,body:response.body?JSON.parse(response.body):null};}
const encode=value=>BSON.EJSON.stringify(value,{relaxed:false});
(async()=>{
 const database=await connection.getDatabase();assert.match(database.databaseName,/^kitchen_workflow_check_\d+$/);
 try{
  const id=new ObjectId();const original={_id:id,name:'Eggs',quantity:3,unit:'pieces',storage:'fridge',category:'protein',expiryDate:new Date('2026-11-22T00:00:00Z'),extra:{keep:true}};
  await database.collection('ingredients').insertOne(original);
  const oldPlan={_id:new ObjectId(),name:'Legacy completed',plannedQuantity:1,unit:'bags',status:'completed',purchase:{quantity:1,unit:'bags'}};await database.collection('shopping_items').insertOne(oldPlan);
  await migrateCategories(database,connection.withTransaction);await migrateWorkflow(database,connection.withTransaction);
  const migrated=await database.collection('ingredients').findOne({_id:id});const {categoryId,storageId,batches,stockVersion,...rest}=migrated;assert.equal(encode(rest),encode(original));assert.equal(batches[0].quantity,3);assert.equal(encode(batches[0].expiryDate),encode(original.expiryDate));
  assert.deepEqual(await migrateWorkflow(database,connection.withTransaction),{ingredients:0,shopping_items:0});
  console.log('PASS real migration: original fields/quantity/date and purchase status retained; rerun changes zero records.');
  const location=(await request('/api/storage-locations','POST',{name:'  Counter  '})).body;
  assert.equal((await request('/api/storage-locations','POST',{name:'counter'})).status,409);assert.equal((await request('/api/storage-locations','POST',{name:' '})).status,400);
  assert.equal((await request('/api/storage-locations/'+location._id,'PUT',{name:'Fruit bowl'})).status,200);
  async function picked(name,categoryIdValue=String(categoryId)){const item=(await request('/api/shopping-items','POST',{name,plannedQuantity:4,unit:'pieces',categoryId:categoryIdValue})).body;assert.ok(item._id);assert.equal((await request('/api/shopping-items/'+item._id+'/picked-up','PATCH',{pickedUp:true})).status,200);return item;}
  const egg=await picked('  Egg  ');const fresh=await picked('Fresh fruit',null);
  const visible=await request('/api/shopping-items?categoryId='+categoryId);assert.equal(visible.body.count,1);assert.equal(visible.body.pickedUpCount,2);
  const review=await request('/api/shopping-items/review');assert.equal(review.body.count,2);assert.equal(review.body.items.find(row=>row._id===egg._id).match.ingredient._id,String(id));
  const rows=[{shoppingItemId:egg._id,quantity:1.5,unit:'bags',storageId:location._id,expiryDate:'2026-12-01',matchMode:'auto'},{shoppingItemId:fresh._id,quantity:2,unit:'pieces',storageId:null,expiryDate:null,matchMode:'auto'}];
  failId=fresh._id;const partial=await request('/api/shopping-items/transfer','POST',{items:rows});assert.equal(partial.body.recorded,1);assert.equal(partial.body.failed,1);
  assert.equal(await database.collection('ingredients').countDocuments({}),1);assert.notEqual((await database.collection('shopping_items').findOne({_id:new ObjectId(fresh._id)})).status,'completed');
  const stock=(await request('/api/ingredients?categoryId='+categoryId)).body.ingredients[0];assert.equal(stock.batches.length,2);assert.equal(stock.expiryDate,'2026-11-22T00:00:00.000Z');assert.deepEqual(stock.totals,[{quantity:3,unit:'pieces'},{quantity:1.5,unit:'bags'}]);assert.equal(encode((await database.collection('ingredients').findOne({_id:id})).batches[0]),encode(batches[0]));
  const retry=await request('/api/shopping-items/transfer','POST',{items:rows});assert.equal(retry.body.results[0].alreadyCompleted,true);assert.equal(retry.body.recorded,2);assert.equal((await database.collection('ingredients').findOne({_id:id})).batches.length,2);
  assert.equal(await database.collection('shopping_items').countDocuments({_id:{$in:[new ObjectId(egg._id),new ObjectId(fresh._id)]}}),0);assert.equal(await database.collection('purchase_receipts').countDocuments({}),2);
  console.log('PASS real picked-up persistence, hidden selections, Egg/Eggs matching, incompatible-unit batches, expiry preservation, partial rollback and retry.');
  const alias=await picked('Breakfast protein');const aliased=await request('/api/shopping-items/transfer','POST',{items:[{shoppingItemId:alias._id,quantity:1,unit:'pieces',storageId:null,expiryDate:null,matchMode:'selected',matchId:String(id),rememberAlias:true}]});assert.equal(aliased.body.recorded,1);
  const again=await picked(' breakfast   protein ');assert.equal((await request('/api/shopping-items/review')).body.items.find(item=>item._id===again._id).match.kind,'alias');
  const concurrent=await picked('Egg');const payload={items:[{shoppingItemId:concurrent._id,quantity:1,unit:'pieces',storageId:null,matchMode:'auto'}]};
  const both=await Promise.all([request('/api/shopping-items/transfer','POST',payload),request('/api/shopping-items/transfer','POST',payload)]);assert.ok(both.every(result=>result.body.recorded===1));assert.equal(both.filter(result=>result.body.results[0].alreadyCompleted).length,1);
  console.log('PASS real alias persistence and concurrent-request idempotency.');
  const detail=(await request('/api/storage-locations/'+location._id)).body;assert.equal(detail.inventoryCount,1);assert.equal(detail.batchCount,1);
  assert.equal((await request('/api/storage-locations/'+location._id,'DELETE',detail)).status,204);
  const after=await database.collection('ingredients').findOne({_id:id});assert.equal(after.batches[1].storageId,null);assert.equal(after.batches[1].quantity,1.5);assert.equal(encode(after.batches[0]),encode(batches[0]));assert.equal(after.batches.length,4);
  const firstBatch=String(after.batches[0]._id);const edit=await request('/api/ingredients/'+id,'PUT',{name:'Eggs',batchId:firstBatch,quantity:2,unit:'pieces',storageId:null,expiryDate:'2026-11-24'});assert.equal(edit.status,200);assert.equal((await database.collection('ingredients').findOne({_id:id})).batches[1].quantity,1.5);
  assert.equal((await request('/api/ingredients/'+id+'/batches/'+firstBatch,'DELETE')).status,200);
  assert.equal((await request('/api/ingredients')).body.ingredients.find(item=>item._id===String(id)).batches.length,3);
  const oldAfter=await database.collection('shopping_items').findOne({_id:oldPlan._id});const {categoryId:unusedCategory,storageId:unusedStorage,pickedUp,...oldRest}=oldAfter;assert.equal(encode(oldRest),encode(oldPlan));
  const packaged=await request('/api/ingredients','POST',{name:'Package check',quantity:2,unit:'bags',packageSize:'500 g',storageId:null});assert.equal(packaged.status,201);
  const packagePlan=await picked('Package check');assert.equal((await request('/api/shopping-items/transfer','POST',{items:[{shoppingItemId:packagePlan._id,quantity:1,unit:'bags',packageSize:'1 kg',storageId:null,matchMode:'auto'}]})).body.recorded,1);
  const packages=(await request('/api/ingredients?name=Package')).body.ingredients[0];assert.deepEqual(packages.totals,[{quantity:2,unit:'bags',packageSize:'500 g'},{quantity:1,unit:'bags',packageSize:'1 kg'}]);
  const individual=(await request('/api/shopping-items','POST',{name:'Individual receipt',plannedQuantity:1,unit:'packs'})).body;
  const individualBody={quantity:3,unit:'packs',storageId:null,packageSize:'6-pack',expiryDate:'2026-12-05',destination:'new'};
  const saved=await request('/api/shopping-items/'+individual._id+'/purchase','POST',individualBody);assert.equal(saved.status,200);assert.equal(saved.body.removed,true);assert.equal(saved.body.ingredient.batches[0].expiryDate,'2026-12-05T00:00:00.000Z');assert.equal(saved.body.ingredient.batches[0].packageSize,'6-pack');
  assert.equal(await database.collection('shopping_items').findOne({_id:new ObjectId(individual._id)}),null);assert.equal((await request('/api/shopping-items/'+individual._id+'/purchase','POST',individualBody)).body.alreadyCompleted,true);
  assert.equal((await database.collection('ingredients').findOne({_id:new ObjectId(saved.body.ingredient._id)})).batches.length,1);
  console.log('PASS real atomic list removal, durable receipts, individual dated purchases, and retry after shopping-row deletion.');
  console.log('PASS real location deletion, batch editing/removal, package-size separation, fresh-read persistence, and preservation of old completed plans.');
 }finally{assert.match(database.databaseName,/^kitchen_workflow_check_\d+$/);await database.dropDatabase();console.log('Disposable verification database removed. The shared kitchen_app database was not used.');}
})().catch(error=>{console.error(error.name==='AssertionError'?'Workflow assertion failed: '+error.message:connectionModule.connectionErrorMessage(error));process.exitCode=1;}).finally(connection.close);

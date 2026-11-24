const assert=require('node:assert/strict');
const {test}=require('node:test');
const {ObjectId,BSON}=require('mongodb');
const {memoryDatabase}=require('./memory-db.cjs');
const memory=memoryDatabase();const db=require('../db');db.getDatabase=async()=>memory.db;db.withTransaction=work=>memory.transact(work);
const {migrateWorkflow}=require('../scripts/migrate-workflow');
const {migrateCategories}=require('../scripts/migrate-categories');
const {legacy}=require('../categories');const {legacyLocations}=require('../storage');
const {resolveMatch,normalizeName}=require('../matching');
const expiry=require('../public/expiry');
const handle=require('serverless-http')(require('../app').createApp());
const encode=value=>BSON.EJSON.stringify(value,{relaxed:false});
async function request(path,method='GET',body){const url=new URL(path,'http://localhost');const response=await handle({httpMethod:method,path:url.pathname,queryStringParameters:Object.fromEntries(url.searchParams),headers:{'content-type':'application/json'},body:body===undefined?null:JSON.stringify(body),isBase64Encoded:false},{});return{status:response.statusCode,body:response.body?JSON.parse(response.body):null};}
const food={name:'Eggs',quantity:3,unit:'pieces',storage:'fridge',category:'protein',expiryDate:new Date('2026-11-22T00:00:00Z')};
const plan={name:'Egg',plannedQuantity:4,unit:'pieces',categoryId:String(legacy.protein._id)};
async function setup(){memory.reset({ingredients:[{...food,_id:new ObjectId(),extra:{keep:true}}],shopping_items:[]});await migrateCategories(memory.db,memory.transact);await migrateWorkflow(memory.db,memory.transact);}
async function addPicked(body=plan){const response=await request('/api/shopping-items','POST',body);assert.equal(response.status,201,JSON.stringify(response.body));assert.equal((await request('/api/shopping-items/'+response.body._id+'/picked-up','PATCH',{pickedUp:true})).status,200);return response.body;}
const purchase=item=>({shoppingItemId:item._id,quantity:2,unit:'pieces',storageId:null,expiryDate:null,matchMode:'auto'});

test('Workflow migration preserves all original fields, quantities, dates, names, legacy locations and status, and reruns safely',async()=>{
 memory.reset({ingredients:[{...food,_id:new ObjectId()},{...food,_id:new ObjectId(),name:'Rice',storage:'Root cellar',quantity:2,unit:'bags',expiryDate:null}],shopping_items:[{...plan,_id:new ObjectId(),status:'completed',purchase:{quantity:4,unit:'pieces'}}]});
 const before=memory.snapshot();assert.deepEqual(await migrateWorkflow(memory.db,memory.transact),{ingredients:2,shopping_items:1});
 const after=memory.snapshot();assert.equal(after.storage_locations.length,4);
 assert.equal(encode(after.ingredients.map(({storageId,batches,stockVersion,...item})=>item)),encode(before.ingredients));
 assert.equal(encode(after.shopping_items.map(({storageId,pickedUp,...item})=>item)),encode(before.shopping_items));
 assert.equal(after.ingredients[0].batches[0].quantity,3);assert.equal(encode(after.ingredients[0].batches[0].expiryDate),encode(food.expiryDate));
 assert.equal(after.ingredients[1].batches[0].storageId.toString(),after.storage_locations.find(location=>location.name==='Root cellar')._id.toString());
 assert.deepEqual(await migrateWorkflow(memory.db,memory.transact),{ingredients:0,shopping_items:0});assert.equal(encode(memory.snapshot()),encode(after));
 const detail=(await request('/api/storage-locations/'+legacyLocations.fridge._id)).body;assert.equal((await request('/api/storage-locations/'+legacyLocations.fridge._id,'DELETE',detail)).status,204);await migrateWorkflow(memory.db,memory.transact);assert.equal(memory.snapshot().storage_locations.length,3);
});

test('Locations create/rename reject blanks and case-insensitive duplicates, rename displays everywhere, deletion retains food atomically',async()=>{
 await setup();assert.equal((await request('/api/storage-locations','POST',{name:' '})).status,400);
 const location=(await request('/api/storage-locations','POST',{name:'  Counter  '})).body;assert.equal(location.name,'Counter');
 assert.equal((await request('/api/storage-locations','POST',{name:'cOUNTER'})).status,409);
 const created=await request('/api/ingredients','POST',{name:'Apple',quantity:2,unit:'pieces',storageId:location._id});assert.equal(created.status,201);
 const raw=memory.snapshot().ingredients.find(item=>String(item._id)===created.body._id);
 assert.equal((await request('/api/storage-locations/'+location._id,'PUT',{name:'Fruit bowl'})).status,200);
 const fresh=(await request('/api/ingredients?storageId='+location._id)).body.ingredients;assert.equal(fresh[0].storageName,'Fruit bowl');assert.equal(encode(memory.snapshot().ingredients.find(item=>String(item._id)===created.body._id)),encode(raw));
 assert.equal((await request('/api/storage-locations/'+location._id,'PUT',{name:'fridge'})).status,409);
 const path='/api/storage-locations/'+location._id;const detail=(await request(path)).body;assert.equal(detail.inventoryCount,1);assert.equal(detail.batchCount,1);
 assert.equal((await request(path,'DELETE',{...detail,batchCount:0})).status,409);
 const before=encode(memory.snapshot());memory.failWrite('ingredients',new ObjectId(created.body._id));
 const error=console.error;console.error=()=>{};try{assert.equal((await request(path,'DELETE',detail)).status,500);}finally{console.error=error;}
 assert.equal(encode(memory.snapshot()),before);
 assert.equal((await request(path,'DELETE',detail)).status,204);assert.equal(memory.snapshot().ingredients.length,2);
 const unassigned=(await request('/api/ingredients?storageId=null')).body.ingredients;assert.equal(unassigned[0]._id,created.body._id);assert.equal(unassigned[0].storageName,'Unassigned');
 assert.equal((await request('/api/ingredients','POST',{name:'X',quantity:1,unit:'pieces',storageId:location._id})).status,409);
});

test('Expiry uses local calendar days including yesterday/today/+1/+3/+4/none and daylight saving boundaries',()=>{
 const now=new Date(2026,10,23,23,58);
 for(const [date,text,tone]of [['2026-11-22','Expired yesterday','expired'],['2026-11-23','Expires today','soon'],['2026-11-24','Expires tomorrow','soon'],['2026-11-26','Expires in 3 days','soon'],['2026-11-27','Nov 27, 2026','normal']]){const badge=expiry.indicator(date,now);assert.equal(badge.text,text);assert.equal(badge.tone,tone);}
 assert.equal(expiry.indicator(null,now),null);assert.equal(expiry.indicator('2026-11-20',now).text,'Expired 3 days ago');
 assert.equal(expiry.dayDifference('2026-03-09',new Date(2026,2,7,23,59)),2);assert.equal(expiry.dayDifference('2026-11-02',new Date(2026,9,31,23,59)),2);
});

test('Dated stock sorts oldest first and undated last in all and combined category/name/storage filters',async()=>{
 await setup();
 for(const [name,date]of [['Today','2026-11-23'],['Tomorrow','2026-11-24'],['Three days','2026-11-26'],['Four days','2026-11-27'],['Undated',null]])assert.equal((await request('/api/ingredients','POST',{name,quantity:1,unit:'pieces',expiryDate:date,storage:'fridge',categoryId:String(legacy.protein._id)})).status,201);
 for(const query of ['', '?categoryId='+legacy.protein._id, '?categoryId='+legacy.protein._id+'&storage=fridge']){const response=await request('/api/ingredients'+query);assert.deepEqual(response.body.ingredients.map(item=>item.name),['Eggs','Today','Tomorrow','Three days','Four days','Undated']);}
 const filtered=(await request('/api/ingredients?categoryId='+legacy.protein._id+'&name=day&storage=fridge')).body.ingredients;assert.deepEqual(filtered.map(item=>item.name),['Today','Three days','Four days']);
});

test('Picking/unchecking/removing/unplanned entries persist without touching inventory; global selection includes hidden categories',async()=>{
 await setup();const before=encode(memory.snapshot().ingredients);const one=await addPicked();const two=await addPicked({...plan,name:'Unplanned fruit',categoryId:String(legacy.fruits_vegetables._id)});
 const filtered=(await request('/api/shopping-items?categoryId='+legacy.protein._id)).body;assert.equal(filtered.count,1);assert.equal(filtered.pickedUpCount,2);
 assert.equal((await request('/api/shopping-items/review')).body.count,2);
 await request('/api/shopping-items/'+one._id+'/picked-up','PATCH',{pickedUp:false});assert.equal((await request('/api/shopping-items/review')).body.count,1);
 await request('/api/shopping-items/'+two._id,'DELETE');assert.equal((await request('/api/shopping-items/review')).body.count,0);assert.equal(encode(memory.snapshot().ingredients),before);
 assert.equal((await request('/api/shopping-items/transfer','POST',{items:[purchase(one)]})).body.results[0].status,409);
});

test('Matching prioritizes links, confirmed aliases, normalized exact and conservative plurals, and exposes ambiguity',()=>{
 const egg={_id:new ObjectId(),name:'Eggs'}, chicken={_id:new ObjectId(),name:'Chicken thighs'};
 assert.equal(normalizeName('  CHICKEN   thighs '),'chicken thighs');
 assert.equal(resolveMatch({name:'Egg',ingredientId:egg._id},[egg,chicken]).kind,'linked');
 assert.equal(resolveMatch({name:'breakfast',ingredientId:new ObjectId()},[egg],[{_id:'breakfast',ingredientId:egg._id}]).kind,'alias');
 assert.equal(resolveMatch({name:'  EGGS  '},[egg]).kind,'exact');assert.equal(resolveMatch({name:'Egg'},[egg]).kind,'plural');
 assert.equal(resolveMatch({name:'Egg',ingredientId:new ObjectId()},[egg]).ingredient,egg);
 assert.equal(resolveMatch({name:'Egg'},[egg,{...egg,_id:new ObjectId()}]).kind,'ambiguous');
 for(const name of ['Chicken breast','Hummu','Asparagu','Rice','Chicken'])assert.equal(resolveMatch({name},[chicken,{_id:new ObjectId(),name:'Hummus'},{_id:new ObjectId(),name:'Asparagus'}]).kind,'new');
});

test('Bulk transfers hidden selections, preserves old dates/category and incompatible units in distinct batches, supports alias and Keep separate',async()=>{
 await setup();const source=memory.snapshot().ingredients[0];const before=encode(source.batches[0]);
 assert.equal((await request('/api/shopping-items','POST',{...plan,ingredientId:new ObjectId().toString()})).status,404);
 const egg=await addPicked();const other=await addPicked({...plan,name:'Unplanned item',categoryId:String(legacy.grains._id)});
 const response=await request('/api/shopping-items/transfer','POST',{items:[{...purchase(egg),unit:'bags',quantity:4,expiryDate:'2026-12-01',storageId:String(legacyLocations.pantry._id),categoryId:String(legacy.grains._id)},purchase(other)]});
 assert.equal(response.body.recorded,2);const fresh=(await request('/api/ingredients?categoryId='+legacy.protein._id)).body.ingredients[0];
 assert.equal(fresh._id,String(source._id));assert.equal(fresh.batches.length,2);assert.equal(fresh.expiryDate,'2026-11-22T00:00:00.000Z');assert.deepEqual(fresh.totals,[{quantity:3,unit:'pieces'},{quantity:4,unit:'bags'}]);assert.equal(encode(memory.snapshot().ingredients[0].batches[0]),before);
 const separate=await addPicked();assert.equal((await request('/api/shopping-items/transfer','POST',{items:[{...purchase(separate),matchMode:'separate'}]})).body.recorded,1);
 const alias=await addPicked({...plan,name:'Breakfast protein'});
 assert.equal((await request('/api/shopping-items/transfer','POST',{items:[{...purchase(alias),matchMode:'selected',matchId:String(source._id),rememberAlias:true}]})).body.recorded,1);
 const repeat=await addPicked({...plan,name:' Breakfast   protein '});const review=(await request('/api/shopping-items/review')).body.items.find(item=>item._id===repeat._id);assert.equal(review.match.kind,'alias');assert.equal(review.match.ingredient._id,String(source._id));
 assert.equal((await request('/api/shopping-items/'+egg._id+'/picked-up','PATCH',{pickedUp:false})).status,409);
});

test('Server idempotency, partial failures, rollback and retry prevent double stock additions and never record failed writes',async(t)=>{
 await setup();t.mock.method(console,'error',()=>{});
 const first=await addPicked();const second=await addPicked({...plan,name:'New item'});const rows=[purchase(first),purchase(second)];
 memory.failWrite('shopping_items',new ObjectId(second._id));const firstResult=await request('/api/shopping-items/transfer','POST',{items:rows});assert.equal(firstResult.body.recorded,1);assert.equal(firstResult.body.failed,1);
 const state=memory.snapshot();assert.equal(state.ingredients.length,1);assert.equal(state.ingredients[0].batches.length,2);assert.equal(state.shopping_items[1].status,undefined);assert.equal(state.shopping_items[1].pickedUp,true);
 const retried=await request('/api/shopping-items/transfer','POST',{items:rows});assert.equal(retried.body.results[0].alreadyCompleted,true);assert.equal(retried.body.recorded,2);assert.equal(memory.snapshot().ingredients[0].batches.length,2);assert.equal(memory.snapshot().ingredients.length,2);
 const snapshot=encode(memory.snapshot().ingredients);await request('/api/shopping-items/transfer','POST',{items:rows});assert.equal(encode(memory.snapshot().ingredients),snapshot);
 const another=await addPicked();const concurrent=await Promise.all([request('/api/shopping-items/transfer','POST',{items:[purchase(another)]}),request('/api/shopping-items/transfer','POST',{items:[purchase(another)]})]);assert.equal(concurrent.filter(result=>result.body.results[0].alreadyCompleted).length,1);assert.equal(memory.snapshot().ingredients[0].batches.length,3);
});

test('Batch editing/removal targets only the chosen batch and retains ingredient identity and other purchases',async()=>{
 await setup();const source=memory.snapshot().ingredients[0];const picked=await addPicked();await request('/api/shopping-items/transfer','POST',{items:[purchase(picked)]});
 const before=memory.snapshot().ingredients[0];const old=before.batches[0];
 assert.equal((await request('/api/ingredients/'+source._id,'PUT',{name:'Eggs',quantity:1,unit:'pieces',storageId:null})).status,409);
 const edit=await request('/api/ingredients/'+source._id,'PUT',{name:'Eggs',batchId:String(old._id),quantity:1,unit:'pieces',storageId:null,expiryDate:'2026-11-24'});assert.equal(edit.status,200);assert.equal(encode(memory.snapshot().ingredients[0].batches[1]),encode(before.batches[1]));
 const removed=await request('/api/ingredients/'+source._id+'/batches/'+old._id,'DELETE');assert.equal(removed.status,200);assert.equal(removed.body._id,String(source._id));assert.equal(removed.body.batches.length,1);assert.equal(removed.body.expiryDate,null);assert.equal(removed.body.quantity,2);
 assert.equal((await request('/api/ingredients')).body.ingredients[0].batches.length,1);
});


test('Review recovers a stale link; ambiguous matches need an explicit one-tap selection or Keep separate',async()=>{
 await setup();const egg=await addPicked();
 await memory.db.collection('shopping_items').updateOne({_id:new ObjectId(egg._id)},{$set:{ingredientId:new ObjectId()}});
 let review=(await request('/api/shopping-items/review')).body;assert.equal(review.items[0].match.kind,'plural');assert.equal(review.items[0].match.ingredient.name,'Eggs');
 const second=await request('/api/ingredients','POST',{name:'Eggs',quantity:1,unit:'packs',storageId:null});assert.equal(second.status,201);
 review=(await request('/api/shopping-items/review')).body;assert.equal(review.items[0].match.kind,'ambiguous');assert.equal(review.items[0].match.candidates.length,2);
 assert.equal((await request('/api/shopping-items/transfer','POST',{items:[purchase(egg)]})).body.results[0].status,409);
 const explicit=await request('/api/shopping-items/transfer','POST',{items:[{...purchase(egg),matchMode:'selected',matchId:second.body._id,rememberAlias:true}]});assert.equal(explicit.body.recorded,1);
 assert.equal(memory.snapshot().ingredients[0].batches.length,1);assert.equal(memory.snapshot().ingredients[1].batches.length,2);
});


test('Local calendar countdowns remain correct in western/eastern timezones and across DST',()=>{
 const {execFileSync}=require('node:child_process');
 for(const timezone of ['America/Toronto','Pacific/Honolulu','Pacific/Auckland']) {
  const result=execFileSync(process.execPath,['-e',"const e=require('./public/expiry');console.log(JSON.stringify([e.dayDifference('2026-03-09',new Date(2026,2,7,23,59)),e.dayDifference('2026-11-02',new Date(2026,9,31,23,59)),e.indicator('2026-11-23',new Date(2026,10,23,0,1)).text]));"],{cwd:require('node:path').join(__dirname,'..'),env:{...process.env,TZ:timezone},encoding:'utf8'});
  assert.deepEqual(JSON.parse(result),[2,2,'Expires today']);
 }
});


test('Known package sizes remain separate even with identical unit labels, and the original package size migrates intact',async()=>{
 memory.reset({ingredients:[{...food,_id:new ObjectId(),name:'Rice',unit:'bags',quantity:2,packageSize:'500 g'}],shopping_items:[]});
 await migrateCategories(memory.db,memory.transact);await migrateWorkflow(memory.db,memory.transact);
 assert.equal(memory.snapshot().ingredients[0].batches[0].packageSize,'500 g');
 const item=await addPicked({...plan,name:'Rice',unit:'bags',packageSize:'1 kg'});
 assert.equal((await request('/api/shopping-items/transfer','POST',{items:[{...purchase(item),unit:'bags',quantity:1,packageSize:'1 kg'}]})).body.recorded,1);
 const fresh=(await request('/api/ingredients')).body.ingredients[0];
 assert.deepEqual(fresh.totals,[{quantity:2,unit:'bags',packageSize:'500 g'},{quantity:1,unit:'bags',packageSize:'1 kg'}]);
 assert.equal(fresh.batches.length,2);
 assert.equal((await request('/api/ingredients','POST',{name:'X',quantity:1,unit:'bags',packageSize:{bad:true}})).status,400);
});


test('An unchanged legacy unit remains verbatim during quantity edits and purchase recording',async()=>{
 memory.reset({ingredients:[{...food,_id:new ObjectId(),unit:' grams '}],shopping_items:[]});await migrateCategories(memory.db,memory.transact);await migrateWorkflow(memory.db,memory.transact);
 const source=memory.snapshot().ingredients[0];
 const edited=await request('/api/ingredients/'+source._id,'PUT',{name:'Eggs',quantity:1,unit:' grams ',storageId:null});assert.equal(edited.status,200);assert.equal(edited.body.unit,' grams ');
 const id=new ObjectId();await memory.db.collection('shopping_items').insertOne({_id:id,name:'Egg',plannedQuantity:2,unit:' grams ',pickedUp:true});
 const transferred=await request('/api/shopping-items/transfer','POST',{items:[{shoppingItemId:String(id),quantity:2,unit:' grams ',storageId:null,matchMode:'auto'}]});assert.equal(transferred.body.recorded,1);
 const fresh=(await request('/api/ingredients')).body.ingredients[0];assert.equal(fresh.unit,' grams ');assert.equal(fresh.quantity,3);assert.ok(fresh.batches.every(batch=>batch.unit===' grams '));
});

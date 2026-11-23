const assert=require('node:assert/strict');
const {test}=require('node:test');
const {ObjectId}=require('mongodb');
const {memoryDatabase}=require('./memory-db.cjs');
const memory=memoryDatabase();const db=require('../db');db.getDatabase=async()=>memory.db;db.withTransaction=work=>memory.transact(work);
const {migrateCategories}=require('../scripts/migrate-categories');const {legacy}=require('../categories');
const handle=require('serverless-http')(require('../app').createApp());
async function request(path,method='GET',body){const url=new URL(path,'http://localhost');const res=await handle({httpMethod:method,path:url.pathname,queryStringParameters:Object.fromEntries(url.searchParams),headers:{'content-type':'application/json'},body:body===undefined?null:JSON.stringify(body),isBase64Encoded:false},{});return {status:res.statusCode,body:res.body?JSON.parse(res.body):null};}
const ingredient={name:'Fixture eggs',quantity:2,unit:'pieces',storage:'fridge',expiryDate:null};
const plan={name:'Fixture shopping',plannedQuantity:3,unit:'pieces'};
async function setup(){memory.reset({ingredients:[{...ingredient,_id:new ObjectId(),category:'protein',extra:'preserve'},{...ingredient,_id:new ObjectId(),name:'Fixture rice',category:'grains'},{...ingredient,_id:new ObjectId(),name:'Uncategorized'}],shopping_items:[{...plan,_id:new ObjectId(),category:'protein',status:'completed',extra:'preserve'},{...plan,_id:new ObjectId(),category:'other'}]});await migrateCategories(memory.db,memory.transact);}

test('Migration maps only categories, preserves records/status, reruns safely and does not resurrect deleted categories',async()=>{
 await setup();const before=memory.snapshot();assert.equal(before.categories.length,3);assert.equal(String(before.ingredients[0].categoryId),String(legacy.protein._id));assert.equal(before.ingredients[2].categoryId,null);assert.equal(before.shopping_items[0].status,'completed');assert.equal(before.shopping_items[1].categoryId,null);
 assert.deepEqual(await migrateCategories(memory.db,memory.transact),{ingredients:0,shopping_items:0});assert.deepEqual(memory.snapshot(),before);
 const id=String(legacy.protein._id);const detail=(await request('/api/categories/'+id)).body;assert.equal((await request('/api/categories/'+id,'DELETE',detail)).status,204);await migrateCategories(memory.db,memory.transact);assert.equal(memory.snapshot().categories.length,2);assert.equal(memory.snapshot().ingredients[0].categoryId,null);assert.equal(memory.snapshot().ingredients[0].extra,'preserve');
});
test('Create/rename reject blank and case-insensitive duplicates; rename changes names without rewriting items',async()=>{
 await setup();const created=await request('/api/categories','POST',{name:'  Snacks  '});assert.equal(created.status,201);assert.equal(created.body.name,'Snacks');const id=created.body._id;
 assert.equal((await request('/api/categories','POST',{name:'sNaCkS'})).status,409);assert.equal((await request('/api/categories','POST',{name:' '})).status,400);assert.equal((await request('/api/categories','POST',{name:'Uncategorized'})).status,400);
 const food=await request('/api/ingredients','POST',{...ingredient,categoryId:id});const stored=memory.snapshot().ingredients.find(row=>String(row._id)===food.body._id);
 assert.equal((await request('/api/categories/'+id,'PUT',{name:'Treats'})).status,200);const fresh=(await request('/api/ingredients?categoryId='+id)).body.ingredients;assert.equal(fresh[0].categoryName,'Treats');assert.deepEqual(memory.snapshot().ingredients.find(row=>String(row._id)===food.body._id),stored);
 assert.equal((await request('/api/categories/'+id,'PUT',{name:'protein'})).status,409);
});
test('Server validates references, preserves omitted assignments, supports combined filters and Uncategorized',async()=>{
 await setup();const id=String(legacy.protein._id);const item=(await request('/api/ingredients?categoryId='+id+'&name=eggs&storage=fridge')).body.ingredients[0];assert.equal(item.categoryName,'Protein');
 assert.equal((await request('/api/ingredients/'+item._id,'PUT',ingredient)).body.categoryId,id);
 assert.equal((await request('/api/ingredients','POST',{...ingredient,categoryId:new ObjectId().toString()})).status,409);
 assert.equal((await request('/api/ingredients','POST',{...ingredient,categoryId:'bad'})).status,400);assert.equal((await request('/api/ingredients?categoryId=bad')).status,400);
 assert.equal((await request('/api/ingredients?categoryId=null')).body.count,1);
 assert.equal((await request('/api/ingredients?category=protein')).body.count,1);
});
test('Delete confirms usage, clears both lists atomically, preserves food/status, and rolls back partial failure',async(t)=>{
 await setup();t.mock.method(console,'error',()=>{});const id=String(legacy.protein._id);const path='/api/categories/'+id;const detail=(await request(path)).body;assert.equal(detail.inventoryCount,1);assert.equal(detail.shoppingCount,1);
 assert.equal((await request(path,'DELETE',{...detail,inventoryCount:0})).status,409);
 const before=memory.snapshot();memory.fail('shopping_items');assert.equal((await request(path,'DELETE',detail)).status,500);assert.deepEqual(memory.snapshot(),before);
 assert.equal((await request(path,'DELETE',detail)).status,204);const after=memory.snapshot();assert.equal(after.ingredients.length,before.ingredients.length);assert.equal(after.shopping_items.length,before.shopping_items.length);assert.equal(after.shopping_items[0].status,'completed');assert.equal(after.ingredients[0].categoryId,null);assert.equal(after.shopping_items[0].categoryId,null);
 assert.equal((await request('/api/ingredients?categoryId='+id)).body.count,0);assert.equal((await request('/api/shopping-items?categoryId=null')).body.count,2);
 assert.equal((await request('/api/shopping-items','POST',{...plan,categoryId:id})).status,409);
});
test('Shopping copy/edit/filter and purchase override preserve existing inventory assignments and prevent repeated purchases',async()=>{
 await setup();const source=memory.snapshot().ingredients[0];const id=String(source.categoryId);
 const linked=await request('/api/shopping-items','POST',{...plan,name:source.name,ingredientId:String(source._id)});assert.equal(linked.body.categoryId,id);
 const grains=String(legacy.grains._id);const path='/api/shopping-items/'+linked.body._id;assert.equal((await request(path,'PUT',{...plan,categoryId:grains})).body.categoryId,grains);assert.equal((await request(path,'PUT',plan)).body.categoryId,grains);assert.equal(memory.snapshot().ingredients[0].categoryId.toString(),id);
 assert.equal((await request('/api/shopping-items?categoryId='+grains)).body.count,1);
 const purchase={quantity:3,unit:'pieces',destination:'existing',storage:'fridge',categoryId:grains};const combined=await request(path+'/purchase','POST',purchase);assert.equal(combined.body.ingredient.categoryId,id);assert.equal(combined.body.shoppingItem.categoryId,grains);assert.equal((await request(path+'/purchase','POST',purchase)).body.alreadyCompleted,true);
 const newPlan=await request('/api/shopping-items','POST',{...plan,categoryId:grains});const bought=await request('/api/shopping-items/'+newPlan.body._id+'/purchase','POST',{...purchase,destination:'new'});assert.equal(bought.body.ingredient.categoryId,grains);
 const override=await request('/api/shopping-items','POST',{...plan,categoryId:grains});const changed=await request('/api/shopping-items/'+override.body._id+'/purchase','POST',{...purchase,destination:'new',categoryId:id});assert.equal(changed.body.ingredient.categoryId,id);assert.equal(changed.body.shoppingItem.categoryId,grains);
 await request('/api/categories/'+grains,'PUT',{name:'Staples'});assert.ok((await request('/api/shopping-items?categoryId='+grains)).body.shoppingItems.every(item=>item.categoryName==='Staples'));
});

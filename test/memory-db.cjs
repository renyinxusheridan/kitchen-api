const { ObjectId, BSON } = require('mongodb');
const clone = value => BSON.EJSON.parse(BSON.EJSON.stringify(value));
const eq = (a,b) => a instanceof ObjectId || b instanceof ObjectId ? String(a)===String(b) : a===b;
function matches(row,filter={}) {
 return Object.entries(filter).every(([key,value])=>{
  if(key==='$or')return value.some(part=>matches(row,part));
  if(key==='$and')return value.every(part=>matches(row,part));
  if(value && typeof value==='object' && !(value instanceof ObjectId) && !(value instanceof Date)) {
   return Object.entries(value).every(([op,v])=>op==='$exists'?(row[key]!==undefined)===v:op==='$ne'?!eq(row[key],v):op==='$in'?v.some(x=>x===null?row[key]==null:eq(row[key],x)):op==='$regex'?new RegExp(v,value.$options||'').test(row[key]||''):op==='$options');
  }
  return eq(row[key],value);
 });
}
function memoryDatabase() {
 let state={ingredients:[],shopping_items:[],categories:[],_migrations:[]};let failOn;
 function unique(name,record) {if(name==='categories' && state[name].some(row=>!eq(row._id,record._id)&&row.nameKey===record.nameKey))throw Object.assign(new Error('duplicate'),{code:11000});}
 const db={collection(name){state[name] ||= [];return {
  async createIndex(){},
  find(filter={}){let data=state[name].filter(row=>matches(row,filter));return {sort(){return this;},limit(n){data=data.slice(0,n);return this;},project(){return this;},async toArray(){return clone(data);}};},
  async findOne(filter){return clone(state[name].find(row=>matches(row,filter))||null);},
  async countDocuments(filter){return state[name].filter(row=>matches(row,filter)).length;},
  async insertOne(row){row={_id:new ObjectId(),...clone(row)};unique(name,row);state[name].push(row);return {insertedId:row._id};},
  async updateOne(filter,update,options={}){
   let row=state[name].find(row=>matches(row,filter));let inserted=false;
   if(!row && options.upsert){row={_id:filter._id||new ObjectId()};state[name].push(row);inserted=true;}
   if(!row)return {matchedCount:0,modifiedCount:0};
   const updated={...row,...clone(update.$set||{}),...(inserted?clone(update.$setOnInsert||{}):{})};for(const [k,v]of Object.entries(update.$inc||{}))updated[k]=(updated[k]||0)+v;
   unique(name,updated);Object.assign(row,updated);return {matchedCount:1,modifiedCount:1};
  },
  async findOneAndUpdate(filter,update,options){const row=state[name].find(row=>matches(row,filter));if(!row)return null;const id=row._id;await this.updateOne(filter,update,options);return this.findOne({_id:id});},
  async updateMany(filter,update){if(failOn===name){failOn=null;throw Error('Injected failure');}let n=0;for(const row of state[name].filter(row=>matches(row,filter))){await this.updateOne({_id:row._id},update);n++;}return {modifiedCount:n};},
  async deleteOne(filter){const i=state[name].findIndex(row=>matches(row,filter));if(i<0)return {deletedCount:0};state[name].splice(i,1);return {deletedCount:1};}
 };}};
 return {db,reset(value){state=clone(value);for(const name of ['ingredients','shopping_items','categories','_migrations'])state[name] ||= [];},snapshot:()=>clone(state),fail(name){failOn=name;},async transact(work){const before=clone(state);try{return await work(db,{});}catch(error){state=before;throw error;}}};
}
module.exports={memoryDatabase};

(() => {
  const ui=globalThis.kitchenUI;
  const form=document.querySelector('#bulk-form');
  const rowsNode=document.querySelector('#bulk-rows');
  const save=document.querySelector('#bulk-save');
  const message=document.querySelector('#bulk-message');
  let rows=[], inventory=[], busy=false;
  const node=(tag,className,text)=>{const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;};
  function feedback(el,text,error=false){el.textContent=text;el.className='form-message '+(error?'error':'success');}
  function button(text,fn){const el=node('button','button secondary',text);el.type='button';el.addEventListener('click',fn);return el;}
  function field(labelText,input){const el=node('div','field');const label=node('label','',labelText);label.htmlFor=input.id;el.append(label,input);return el;}
  function controls(){for(const el of form.querySelectorAll('button,input,select'))el.disabled=busy || !!el.closest('.custom-unit-field')?.hidden;save.disabled=busy || !rows.length;}
  function title(food){return food.name+' · '+(food.totals || []).map(total=>total.quantity+' '+total.unit+(total.packageSize?' ('+total.packageSize+')':'')).join(' · ')+' · '+food.storageName;}
  function rowView(row,index){
    const card=node('li','bulk-review-row');row.node=card;
    card.append(node('h3','',row.item.name));
    const quantity=node('input');quantity.type='number';quantity.min='0';quantity.step='any';quantity.required=true;quantity.id='review-quantity-'+index;quantity.value=row.quantity;
    const unit=node('select');unit.id='review-unit-'+index;
    const fields=node('div','field-row');fields.append(field('Purchased quantity',quantity),field('Unit',unit));card.append(fields);
    globalThis.kitchenUnits.bind(unit,row.unit);
    const summary=node('p','bulk-summary');card.append(summary);
    function updateSummary(){
      row.quantity=Number(quantity.value);row.unit=globalThis.kitchenUnits.value(unit);
      const target=row.mode==='separate'?null:row.target;
      const amount=quantity.value+' '+row.unit+(row.packageSize?' ('+row.packageSize+')':'');
      summary.textContent=row.mode==='ambiguous'?'Choose a match below':target?'Add '+amount+' to '+target.name:'New ingredient: '+row.item.name+' · '+amount;
    }
    quantity.addEventListener('input',()=>{quantity.setCustomValidity('');updateSummary();});
    unit.addEventListener('change',updateSummary);unit.addEventListener('input',updateSummary);
    const suggested=node('div','bulk-match-actions');
    if(row.item.match.kind==='ambiguous') {
      for(const food of row.item.match.candidates)suggested.append(button('Use '+title(food),()=>choose(food)));
      suggested.append(button('Keep separate',()=>choose(null)));
      card.append(suggested);
    }
    const details=node('details');details.append(node('summary','','Details & match'));
    const matchSelect=node('select');matchSelect.id='review-match-'+index;
    const automatic=node('option','','Automatic match');automatic.value='auto';matchSelect.append(automatic);
    const separate=node('option','','Keep separate');separate.value='separate';matchSelect.append(separate);
    for(const food of inventory){const option=node('option','',title(food));option.value=food._id;matchSelect.append(option);}
    matchSelect.value=row.mode==='selected'?row.target._id:row.mode==='separate'?'separate':'auto';
    details.append(field('Ingredient match',matchSelect));
    const aliasLabel=node('label','alias-choice');const alias=node('input');alias.type='checkbox';alias.id='review-alias-'+index;alias.checked=row.rememberAlias;aliasLabel.append(alias,node('span','','Remember this shopping name for this ingredient'));details.append(aliasLabel);
    aliasLabel.hidden=row.mode!=='selected';alias.addEventListener('change',()=>{row.rememberAlias=alias.checked;});
    const storage=node('select');storage.id='review-storage-'+index;storage.setAttribute('data-storage','');globalThis.storageUI.set(storage,row.storageId);
    details.append(field('Storage location',storage));storage.addEventListener('change',()=>{row.storageId=storage.value || null;row.storageEdited=true;});row.storage=storage;
    const category=node('select');category.id='review-category-'+index;category.setAttribute('data-category','');globalThis.categoryUI.set(category,row.categoryId);
    const categoryField=field('Category',category);details.append(categoryField);categoryField.hidden=!!row.target && row.mode!=='separate';category.addEventListener('change',()=>{row.categoryId=category.value || null;});
    const packageSize=node('input');packageSize.id='review-package-'+index;packageSize.maxLength=60;packageSize.value=row.packageSize;packageSize.placeholder='e.g. 500 g bag, 6-pack';details.append(field('Package size (optional)',packageSize));packageSize.addEventListener('input',()=>{row.packageSize=packageSize.value.trim();updateSummary();});
    const expiry=node('input');expiry.id='review-expiry-'+index;expiry.type='date';expiry.min='0001-01-01';expiry.max='9999-12-31';expiry.value=row.expiryDate;details.append(field('Expiry date (optional)',expiry));expiry.addEventListener('input',()=>{row.expiryDate=expiry.value;});
    const stock=node('p','form-hint');details.append(stock);
    function choose(food){
      row.mode=food?'selected':'separate';row.target=food;row.rememberAlias=!!food;
      alias.checked=row.rememberAlias;matchSelect.value=food?food._id:'separate';aliasLabel.hidden=!food;categoryField.hidden=!!food;suggested.hidden=true;
      if(!row.storageEdited){row.storageId=food ? food.batches.find(batch=>batch.quantity>0)?.storageId || null : row.item.storageId || globalThis.storageUI.preferred() || null;globalThis.storageUI.set(storage,row.storageId);}
      if(!food){row.categoryId=row.item.categoryId || null;globalThis.categoryUI.set(category,row.categoryId);}
      updateSummary();stock.textContent=food?'Older stock keeps its own expiry, storage and unit.':'';
    }

    matchSelect.addEventListener('change',()=>{
      if(matchSelect.value==='auto'){const match=row.item.match;row.mode=match.kind==='ambiguous'?'ambiguous':'auto';row.target=match.ingredient || null;row.rememberAlias=false;aliasLabel.hidden=true;categoryField.hidden=!!row.target;suggested.hidden=row.mode!=='ambiguous';updateSummary();}
      else choose(inventory.find(food=>food._id===matchSelect.value) || null);
    });
    stock.textContent=row.target?'Older stock keeps its own expiry, storage and unit.':'';
    row.error=node('p','form-message');row.error.setAttribute('role','status');row.error.setAttribute('aria-live','polite');
    card.append(aliasLabel,details,row.error);updateSummary();return card;
  }
  async function open(){
    if(busy)return;
    if(!globalThis.categoryUI.available() || !globalThis.storageUI.available()){ui.toast('Refresh categories and locations in Settings before reviewing purchases.',true);return;}
    rows=[];save.textContent='Add picked-up items to My Kitchen';rowsNode.replaceChildren();busy=true;controls();feedback(message,'Loading all picked-up items…');
    ui.open('bulk-dialog',{onCancel:()=>ui.dismiss('bulk-dialog'),busy:()=>busy,fallback:'#add-shopping'});
    try{
      const data=await globalThis.shoppingUI.request('/review');inventory=data.inventory;
      rows=data.items.map(item=>{
        const target=item.match.ingredient;
        const targetBatch=target?.batches?.find(batch=>batch.quantity>0);
        return{item,target,mode:item.match.kind==='ambiguous'?'ambiguous':'auto',rememberAlias:false,
          quantity:item.plannedQuantity,unit:item.unit,categoryId:target?.categoryId || item.categoryId || null,
          storageId:targetBatch ? targetBatch.storageId : item.storageId || globalThis.storageUI.preferred() || null,expiryDate:'',packageSize:item.packageSize || ''};
      });
      rowsNode.replaceChildren(...rows.map(rowView));
      globalThis.storageUI.set(document.querySelector('#bulk-storage'),globalThis.storageUI.preferred());
      feedback(message,rows.length?rows.length+' picked-up item(s), including hidden categories.':'No picked-up items remain.');
    }catch(error){feedback(message,error.message,true);}
    finally{busy=false;controls();save.focus();}
  }
  document.querySelector('#transfer-picked').addEventListener('click',open);
  document.querySelector('#apply-bulk-storage').addEventListener('click',()=>{
    const value=document.querySelector('#bulk-storage').value;
    for(const row of rows){row.storageId=value || null;row.storageEdited=true;globalThis.storageUI.set(row.storage,value);}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy || !rows.length)return;
    let invalid=false;
    for(const row of rows){
      if(row.mode==='ambiguous'){feedback(row.error,'Choose a suggested match or Keep separate.',true);invalid=true;row.node.querySelector('button')?.focus();}
      if(!Number.isFinite(row.quantity) || row.quantity<=0){feedback(row.error,'Enter a purchased quantity greater than zero.',true);invalid=true;}
    }
    if(invalid || !form.reportValidity())return;
    const payload=rows.map(row=>({shoppingItemId:row.item._id,quantity:row.quantity,unit:row.unit,packageSize:row.packageSize || null,storageId:row.storageId,categoryId:row.categoryId,expiryDate:row.expiryDate || null,matchMode:row.mode, ...(row.mode==='selected'?{matchId:row.target._id,rememberAlias:row.rememberAlias}:{})}));
    busy=true;controls();ui.busy(true);feedback(message,'Saving reviewed purchases…');
    let recorded=0;
    try{
      // One confirmation can handle every selected item. Keep each server request
      // bounded while item IDs remain the durable keys across all retries.
      for(let offset=0;offset<payload.length;offset+=25){
        const response=await globalThis.shoppingUI.request('/transfer','POST',{items:payload.slice(offset,offset+25)});
        for(const result of response.results){
          const row=rows.find(row=>row.item._id===result.shoppingItemId);
          if(result.success){recorded++;globalThis.kitchenUnits.remember(row.unit);globalThis.storageUI.remember(row.storageId);row.node.remove();rows=rows.filter(item=>item!==row);}
          else feedback(row.error,result.error,true);
        }
      }
      await ui.refreshAll();
      if(!rows.length){ui.dismiss('bulk-dialog');ui.toast('Recorded '+recorded+' purchase(s). Unpicked items remain on your list.');}
      else{feedback(message,'Recorded '+recorded+' item(s). '+rows.length+' need attention; correct them below and retry.',true);save.textContent='Retry remaining purchases';}
    }catch(error){feedback(message,'Unable to confirm every result. '+recorded+' confirmed; retrying remaining items is safe and will not add recorded stock twice.',true);await ui.refreshAll();}
    finally{busy=false;controls();ui.busy(false);if(rows.length)rows[0].node.querySelector('input')?.focus();}
  });
})();

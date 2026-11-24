(() => {
  const ui = globalThis.kitchenUI;
  const form = document.querySelector('#shopping-form');
  const save = document.querySelector('#shopping-save');
  const formMessage = document.querySelector('#shopping-form-message');
  const cards = document.querySelector('#shopping-cards');
  const list = document.querySelector('#shopping-list');
  const listMessage = document.querySelector('#shopping-list-message');
  const category = document.querySelector('#shopping-category-filter');
  const add = document.querySelector('#add-shopping');
  const refresh = document.querySelector('#shopping-refresh');
  const transfer = document.querySelector('#transfer-picked');
  const endpoint = '/api/shopping-items';
  let items = [], buttons = [], editing = null, removing = null, busy = false, loading = false, version = 0, pickedUpCount = 0;
  const node = (tag, className, text) => { const result=document.createElement(tag);if(className)result.className=className;if(text!==undefined)result.textContent=text;return result; };
  function message(target,text,error=false) { target.textContent=text;target.className='form-message '+(error?'error':'success'); }
  async function request(path,method='GET',body) {
    const response = await fetch(endpoint+path,{method,cache:'no-store',...(body ? {headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {})});
    const data = response.status===204 ? null : await response.json();
    if(!response.ok)throw Error(data?.error || 'Unable to save the shopping item.');
    return data;
  }
  function sync() {
    for(const button of buttons)button.disabled=busy || !!editing || !!removing;
    for(const control of form.elements)control.disabled=busy || !!control.closest('.custom-unit-field')?.hidden;
    category.disabled=busy || !!editing || !!removing;
    refresh.disabled=busy || loading || !!editing || !!removing;
    add.disabled=busy || !!editing || !!removing;
    transfer.disabled=busy || pickedUpCount===0;
    transfer.textContent='To My Kitchen ('+pickedUpCount+')';
    transfer.title='Add all picked-up items to My Kitchen';
    transfer.setAttribute('aria-label','Add all '+pickedUpCount+' picked-up, unrecorded items to My Kitchen, including hidden categories');
  }
  function action(text,fn,danger=false) { const button=node('button','button secondary'+(danger?' danger':''),text);button.type='button';button.addEventListener('click',fn);buttons.push(button);return button; }
  function render() {
    buttons=[];
    cards.replaceChildren(...items.map(item=>{
      const recorded=item.status==='completed';
      const card=node('li','ingredient-card shopping-card'+(recorded?' completed-card':item.pickedUp?' picked-up':''));
      const pickLabel=node('label','pick-control');
      const pick=node('input');pick.type='checkbox';pick.id='picked-'+item._id;pick.checked=recorded || item.pickedUp;pick.disabled=recorded;
      pick.setAttribute('aria-label',(recorded?'Already recorded: ':'Picked up: ')+item.name);
      if(!recorded){buttons.push(pick);pick.addEventListener('change',()=>toggle(item,pick.checked));}
      pickLabel.append(pick);
      const body=node('div','shopping-card-body');
      const header=node('div','card-header');header.append(node('h3','',item.name));
      body.append(header,node('p','amount',item.plannedQuantity+' '+item.unit+(item.packageSize?' ('+item.packageSize+')':'')));
      body.append(node('p','category-name',item.categoryName || 'Uncategorized'));
      if(item.currentInventory) {
        const stock=item.currentInventory;
        const total=(stock.totals || [{quantity:stock.quantity,unit:stock.unit}]).map(total=>total.quantity+' '+total.unit+(total.packageSize?' ('+total.packageSize+')':'')).join(' · ');
        body.append(node('p','stock-note','In kitchen: '+(total || 'No stock')));
      } else if(item.ingredientId) body.append(node('p','stock-note','Linked stock no longer exists. Matches will be checked again.'));
      if(recorded)body.append(node('p','shopping-state','Recorded'+(item.purchase ? ' · '+item.purchase.quantity+' '+item.purchase.unit : '')));
      else if(item.pickedUp)body.append(node('p','shopping-state','Picked up'));
      const edit=action('Edit',()=>openEdit(item));
      const remove=action('Remove',()=>openRemove(item),true);
      const quantity=recorded?null:action('Edit quantity',()=>openEdit(item,true));
      const menu=ui.cardActions(item.name,quantity,edit,remove);buttons.push(menu.toggle);body.append(menu.root);
      card.append(pickLabel,body);return card;
    }));
    document.querySelector('#shopping-count').textContent=items.length;
    listMessage.className='list-message';
    listMessage.textContent=items.length?'':category.value?'No shopping items match this category.':'Your list is empty. Add an item.';
    sync();
  }
  async function load() {
    const current=++version;loading=true;list.setAttribute('aria-busy','true');sync();
    try {
      const data=await request(category.value?'?categoryId='+encodeURIComponent(category.value):'');
      if(current!==version)return;
      items=data.shoppingItems;pickedUpCount=data.pickedUpCount;render();
    } catch(error){if(current===version){listMessage.className='list-message error';listMessage.textContent='Unable to load shopping items. Try Refresh both lists.';}}
    finally{if(current===version){loading=false;list.setAttribute('aria-busy','false');sync();}}
  }
  async function toggle(item,pickedUp) {
    if(busy)return;
    busy=true;sync();
    try {
      await request('/'+item._id+'/picked-up','PATCH',{pickedUp});
      await ui.refreshAll();
    }catch(error){ui.toast(error.message,true);render();}
    finally{busy=false;sync();document.querySelector('#picked-'+item._id)?.focus();}
  }
  function cancelEdit(){if(busy)return;editing=null;ui.dismiss('shopping-dialog');render();}
  function openEdit(item,quantityOnly=false) {
    if(busy || editing || removing)return;
    ++version;loading=false;editing=item || {};
    form.reset();
    form.elements.name.value=item?.name || '';
    form.elements.plannedQuantity.value=item?.plannedQuantity || 1;
    form.elements.packageSize.value=item?.packageSize || '';
    globalThis.kitchenUnits.set(form.elements.unit,item?.unit || globalThis.kitchenUnits.preferred());
    globalThis.categoryUI.set(form.elements.categoryId,item?.categoryId);
    document.querySelector('#shopping-form-heading').textContent=item?'Edit shopping item':'Add shopping item';
    save.textContent=item?'Save changes':'Add shopping item';
    document.querySelector('#shopping-cancel-edit').hidden=false;
    message(formMessage,'');sync();
    ui.open('shopping-dialog',{onCancel:cancelEdit,busy:()=>busy,fallback:'#add-shopping'});
    (quantityOnly?form.elements.plannedQuantity:form.elements.name).focus();
  }
  function openRemove(item) {
    if(busy || editing || removing)return;
    ++version;loading=false;removing=item;
    const content=node('div','delete-confirmation');
    content.append(node('p','','Remove “'+item.name+'” from the shopping list? My Kitchen will stay unchanged.'));
    const feedback=document.querySelector('#shopping-operation-message');message(feedback,'');
    const confirm=action('Confirm remove',async()=>{
      if(busy)return;busy=true;ui.busy(true);confirm.disabled=cancel.disabled=true;sync();
      try{await request('/'+item._id,'DELETE');removing=null;ui.dismiss('shopping-delete-dialog');await ui.refreshAll();ui.toast('Removed “'+item.name+'”.');}
      catch(error){message(feedback,error.message,true);}
      finally{busy=false;confirm.disabled=cancel.disabled=false;sync();ui.busy(false);}
    },true);
    const cancel=action('Cancel',()=>{if(busy)return;removing=null;ui.dismiss('shopping-delete-dialog');render();});
    const actions=node('div','category-inline-actions');actions.append(confirm,cancel);content.append(actions);
    ui.content('shopping-delete-content',content);sync();confirm.disabled=cancel.disabled=false;
    ui.open('shopping-delete-dialog',{onCancel:()=>{if(!busy){removing=null;render();}},busy:()=>busy,fallback:'#add-shopping'});confirm.focus();
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;
    if(!globalThis.categoryUI.available()){message(formMessage,'Refresh categories in Settings before saving.',true);return;}
    const quantity=Number(form.elements.plannedQuantity.value);
    form.elements.plannedQuantity.setCustomValidity(Number.isFinite(quantity)&&quantity>0?'':'Enter a quantity greater than zero.');
    if(!form.reportValidity())return;
    const body={name:form.elements.name.value,plannedQuantity:quantity,unit:globalThis.kitchenUnits.value(form.elements.unit),categoryId:form.elements.categoryId.value || null,packageSize:form.elements.packageSize.value.trim() || null};
    busy=true;ui.busy(true);sync();message(formMessage,'Saving…');
    try{await request(editing?._id?'/'+editing._id:'',editing?._id?'PUT':'POST',body);globalThis.kitchenUnits.remember(body.unit);editing=null;ui.dismiss('shopping-dialog');await ui.refreshAll();ui.toast('Shopping item saved.');}
    catch(error){message(formMessage,error.message,true);}
    finally{busy=false;sync();ui.busy(false);}
  });
  form.elements.plannedQuantity.addEventListener('input',()=>form.elements.plannedQuantity.setCustomValidity(''));
  document.querySelector('#shopping-cancel-edit').addEventListener('click',cancelEdit);
  add.addEventListener('click',()=>openEdit());
  refresh.addEventListener('click',()=>ui.refreshAll());
  category.addEventListener('change',()=>ui.filterChanged('shopping'));
  ui.register('shopping',load);
  globalThis.shoppingUI={load,request};
  load();
})();

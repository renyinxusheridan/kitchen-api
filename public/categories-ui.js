(() => {
  let categories = [];
  let loaded = false;
  let busy = false;
  let editing = null;
  const message = document.querySelector('#categories-message');
  const list = document.querySelector('#categories-list');
  const form = document.querySelector('#category-management-form');
  const name = document.querySelector('#category-name');
  const save = document.querySelector('#category-management-save');
  const cancel = document.querySelector('#category-management-cancel');
  const confirmation = document.querySelector('#category-delete-confirmation');
  function status(text, error = false) { message.textContent = text; message.className = 'form-message ' + (error ? 'error' : 'success'); }
  function set(select, value) {
    const filter = select.hasAttribute('data-category-filter');
    const wanted = value == null ? '' : String(value);
    select.replaceChildren();
    function option(value,text) { const node=document.createElement('option');node.value=value;node.textContent=text;select.append(node); }
    if (filter) option('', 'All categories');
    option(filter ? 'null' : '', 'Uncategorized');
    for (const category of categories) option(category._id,category.name);
    // An Edit sheet can open before the initial request finishes. Retain its
    // reference until the API options arrive; saving is blocked while loading.
    if (!loaded && wanted && ![...select.options].some(option=>option.value===wanted)) option(wanted,'Loading category…');
    select.value = [...select.options].some(option=>option.value===wanted) ? wanted : '';
  }
  async function refresh() {
    const response=await fetch('/api/categories',{cache:'no-store'});
    const data=await response.json();
    if(!response.ok || !Array.isArray(data.categories)) throw Error(data.error || 'Unable to load categories.');
    categories=data.categories;loaded=true;
    for(const select of document.querySelectorAll('[data-category],[data-category-filter]')) set(select,select.value);
    render();
  }
  function button(text, action, danger=false) {
    const node=document.createElement('button');node.type='button';node.className='button secondary'+(danger?' danger':'');node.textContent=text;node.disabled=busy;node.addEventListener('click',action);return node;
  }
  function reset() { editing=null;name.value='';save.textContent='Add category';cancel.hidden=true; }
  function render() {
    list.replaceChildren();
    const fallback=document.createElement('li');fallback.textContent='Uncategorized · built-in';list.append(fallback);
    for(const category of categories) {
      const row=document.createElement('li');row.className='category-manager-row';
      const label=document.createElement('span');label.textContent=category.name;
      const rename=button('Rename',()=>{if(busy)return;confirmation.hidden=true;editing=category;name.value=category.name;save.textContent='Save name';cancel.hidden=false;name.focus();});
      const remove=button('Delete',()=>previewDelete(category),true);
      rename.setAttribute('aria-label','Rename '+category.name);remove.setAttribute('aria-label','Delete '+category.name);
      row.append(label,rename,remove);list.append(row);
    }
    name.disabled=save.disabled=cancel.disabled=busy;
    document.querySelector('#categories-retry').disabled=busy;
  }
  async function run(work, focusAfter) {
    if(busy)return;
    busy=true;render();
    try { await work(); }
    catch(error){status(error instanceof TypeError || error instanceof SyntaxError ? 'Unable to confirm the change. Refresh categories before retrying.' : error.message,true);}
    finally{busy=false;render();if(document.querySelector('#categories-dialog').open)focusAfter?.focus();}
  }
  async function request(path,method,body) {
    const response=await fetch('/api/categories'+path,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const data=response.status===204?null:await response.json();
    if(!response.ok)throw Error(data?.error||'Unable to save categories.');
    return data;
  }
  async function changed(text) { await refresh();await globalThis.kitchenUI.refreshAll();status(text); }
  async function previewDelete(category) {
    await run(async()=>{
      status('Checking category usage…');
      const detail=await request('/'+category._id,'GET');
      reset();confirmation.replaceChildren();confirmation.hidden=false;
      const text=document.createElement('p');text.textContent='Delete “'+detail.name+'”? '+detail.inventoryCount+' inventory record(s) and '+detail.shoppingCount+' shopping item(s) will become Uncategorized. No items will be deleted.';
      const confirm=button('Confirm delete',()=>run(async()=>{
        confirm.disabled=abort.disabled=true;status('Deleting category…');
        try{await request('/'+category._id,'DELETE',{name:detail.name,inventoryCount:detail.inventoryCount,shoppingCount:detail.shoppingCount});confirmation.hidden=true;await changed('Category deleted. Its items are now Uncategorized.');}
        catch(error){confirmation.hidden=true;throw error;}
      },document.querySelector('#categories-retry')),true);
      const abort=button('Cancel',()=>{if(busy)return;confirmation.hidden=true;document.querySelector('#categories-retry').focus();});
      // These controls become available when the usage request has finished.
      confirm.disabled=abort.disabled=false;
      confirmation.append(text,confirm,abort);confirm.focus();status('Review the category usage before confirming.');
    });
  }
  form.addEventListener('submit',event=>{
    event.preventDefault();name.setCustomValidity(name.value.trim()?'':'Enter a category name.');if(!form.reportValidity())return;
    run(async()=>{status('Saving category…');const renamed=!!editing;await request(editing?'/'+editing._id:'',editing?'PUT':'POST',{name:name.value.trim()});reset();await changed(renamed?'Category renamed.':'Category created.');},name);
  });
  name.addEventListener('input',()=>name.setCustomValidity(''));
  cancel.addEventListener('click',()=>{if(!busy)reset();});
  document.querySelector('#categories-retry').addEventListener('click',()=>run(async()=>{confirmation.hidden=true;await refresh();await globalThis.kitchenUI.refreshAll();status('Categories refreshed.');}));
  document.querySelector('#manage-categories').addEventListener('click',()=>{
    globalThis.kitchenUI.dismiss('settings-dialog');
    globalThis.kitchenUI.open('categories-dialog',{onCancel:()=>globalThis.kitchenUI.dismiss('categories-dialog'),busy:()=>busy,fallback:'#settings-button'});
    confirmation.hidden=true;reset();run(async()=>{status('Loading categories…');await refresh();status('');});
  });
  globalThis.categoryUI={set,available:()=>loaded,refresh};
  refresh().catch(()=>{loaded=false;globalThis.kitchenUI.toast('Unable to load categories. Open Settings → Manage categories to retry.',true);});
})();

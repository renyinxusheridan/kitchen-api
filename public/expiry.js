(function(root) {
  const ordinal = (year,month,day) => { const date=new Date(0); date.setUTCFullYear(year,month,day);date.setUTCHours(0,0,0,0);return date.getTime()/86400000; };
  function dayDifference(value, now = new Date()) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
    if (!match) return null;
    return ordinal(+match[1],+match[2]-1,+match[3]) - ordinal(now.getFullYear(),now.getMonth(),now.getDate());
  }
  function indicator(value, now = new Date()) {
    const days = dayDifference(value,now);
    if (days === null) return null;
    if (days < 0) return { tone: 'expired', text: days === -1 ? 'Expired yesterday' : 'Expired '+(-days)+' days ago' };
    if (days <= 3) return { tone: 'soon', text: days === 0 ? 'Expires today' : days === 1 ? 'Expires tomorrow' : 'Expires in '+days+' days' };
    return { tone: 'normal', text: new Intl.DateTimeFormat('en',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(String(value).slice(0,10)+'T00:00:00Z')) };
  }
  function compare(a,b) { return (a.expiryDate || '9999').slice(0,10).localeCompare((b.expiryDate || '9999').slice(0,10)) || a.name.localeCompare(b.name); }
  const api = { dayDifference, indicator, compare };
  if (typeof module === 'object') module.exports = api;
  else root.kitchenExpiry = api;
})(globalThis);

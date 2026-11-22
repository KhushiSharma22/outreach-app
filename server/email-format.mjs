// Minimal, escaped formatting for a human-written outreach email. No remote assets,
// trackers, arbitrary HTML, or clickable URLs are generated from user input.
const escape = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const inline = value => escape(value).replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
export function formatEmail(value,{unsubscribeUrl}={}){
  const raw=String(value||'').replace(/\r\n?/g,'\n');
  const text=raw.replace(/\*\*([^*\n]+)\*\*/g,'$1');
  const blocks=[];let paragraph=[],bullets=[];
  const flushParagraph=()=>{if(paragraph.length){blocks.push('<p>'+paragraph.map(inline).join('<br>')+'</p>');paragraph=[];}};
  const flushBullets=()=>{if(bullets.length){blocks.push('<ul>'+bullets.map(x=>'<li>'+inline(x)+'</li>').join('')+'</ul>');bullets=[];}};
  for(const line of raw.split('\n')){
    const bullet=line.match(/^\s*[-•] +(.+)/);
    if(bullet){flushParagraph();bullets.push(bullet[1]);}
    else if(!line.trim()){flushParagraph();flushBullets();}
    else{flushBullets();paragraph.push(line);}
  }
  flushParagraph();flushBullets();
  let content=blocks.join('');
  if(unsubscribeUrl && /^https:\/\//.test(unsubscribeUrl)){const safe=escape(unsubscribeUrl);content=content.replaceAll(safe,`<a href="${safe}">${safe}</a>`);}
  return {text,html:'<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#222">'+content+'</body></html>'};
}

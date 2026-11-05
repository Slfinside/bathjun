// Loaded only when an unread announcement is about to be shown.
export function showAnnouncement(entry){
 const modal=document.createElement('dialog');modal.className='announcement-dialog';modal.setAttribute('aria-labelledby','announcement-title');
 let position=0,result=null;const opener=document.activeElement;
 const counter=document.createElement('span');counter.className='announcement-counter';counter.setAttribute('aria-live','polite');
 const heading=document.createElement('h2');heading.id='announcement-title';heading.tabIndex=-1;
 const image=document.createElement('img');image.className='announcement-image';image.alt='';image.decoding='async';
 const text=document.createElement('p');text.className='announcement-text';
 const next=document.createElement('button');next.className='primary';next.type='button';
 const skip=document.createElement('button');skip.className='announcement-skip';skip.type='button';skip.textContent='スキップする';
 modal.append(counter,heading,image,text,next,skip);
 function render(){const page=entry.pages[position];counter.textContent=`${position+1} / ${entry.pages.length}`;heading.textContent=page.title;text.textContent=page.text;image.hidden=!page.imageUrl;if(page.imageUrl)image.src=page.imageUrl;else image.removeAttribute('src');next.textContent=position+1===entry.pages.length?'閉じる':'次へ';modal.scrollTop=0;heading.focus({preventScroll:true})}
 next.onclick=()=>{if(position+1<entry.pages.length){position++;render()}else{result=false;modal.close()}};
 skip.onclick=()=>{result=true;modal.close()};modal.addEventListener('cancel',event=>{event.preventDefault();result=true;modal.close()});
 document.body.append(modal);modal.showModal();render();
 return new Promise(resolve=>modal.addEventListener('close',()=>{modal.remove();if(opener?.isConnected)opener.focus();resolve(result)},{once:true}));
}

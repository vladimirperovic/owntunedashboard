(() => {
  'use strict';

  const cfg = Object.assign({ apiBase:'/api', demoOnFailure:true, pollMs:3000, radioPathHint:'/Radio/', preferredOutput:'HomePod' }, window.OWNTONE_DASHBOARD || {});
  const $ = (id) => document.getElementById(id);
  const els = {
    connectionText:$('connectionText'), modeToggle:$('modeToggle'), modeToggleIcon:$('modeToggleIcon'), modeToggleLabel:$('modeToggleLabel'), searchButton:$('searchButton'),
    playerArt:$('playerArt'), artwork:$('artwork'), formatPill:$('formatPill'), playerKicker:$('playerKicker'), statusDot:$('statusDot'), outputName:$('outputName'),
    trackTitle:$('trackTitle'), trackArtist:$('trackArtist'), trackMeta:$('trackMeta'), previousButton:$('previousButton'), playButton:$('playButton'), playIcon:$('playIcon'), nextButton:$('nextButton'),
    progressRange:$('progressRange'), elapsedTime:$('elapsedTime'), remainingTime:$('remainingTime'), volumeRange:$('volumeRange'), volumeValue:$('volumeValue'), outputSelect:$('outputSelect'),
    musicView:$('musicView'), radioView:$('radioView'), quickGrid:$('quickGrid'), refreshButton:$('refreshButton'), shuffleLibraryButton:$('shuffleLibraryButton'), libraryCount:$('libraryCount'),
    albumGrid:$('albumGrid'), playlistGrid:$('playlistGrid'), radioGrid:$('radioGrid'), serverVersion:$('serverVersion'), searchDialog:$('searchDialog'), searchForm:$('searchForm'), searchInput:$('searchInput'), searchResults:$('searchResults'), toast:$('toast')
  };

  const icons = {
    play:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>',
    pause:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM14 5h4v14h-4z"/></svg>',
    radio:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h16v10H4zM7 7l9-4M8 14h.01M12 14h5M12 17h5"/></svg>',
    note:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12M9 9l10-2M6.5 20A2.5 2.5 0 1 0 6.5 15a2.5 2.5 0 0 0 0 5ZM16.5 18A2.5 2.5 0 1 0 16.5 13a2.5 2.5 0 0 0 0 5Z"/></svg>',
    smallPlay:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>'
  };

  const state = {
    mode:'music', online:false, demo:false,
    player:{state:'stop',volume:25,item_progress_ms:0,item_length_ms:0}, current:null, outputs:[], playlists:[], albums:[], library:null, config:null, radioPlaylists:[],
    seekDragging:false, volumeDragging:false, lastVolumeChangeTime:0, volumeDebounceTimer:null, toastTimer:null, searchTimer:null
  };

  const demo = {
    player:{state:'play',volume:18,item_progress_ms:126000,item_length_ms:306000,item_id:'demo'},
    current:{id:'demo',title:'La Vie En Rose',artist:'Grace Jones',album:'Portfolio',type:'flac',bitrate:'Lossless',samplerate:'44100',data_kind:'file'},
    outputs:[{id:'hp',name:'HomePod mini',type:'AirPlay',selected:true,volume:18}], library:{songs:8283,albums:714,artists:489},
    playlists:[
      {id:'p1',name:'Favorites',path:'/media/music/Playlists/Favorites.smartpl',uri:'library:playlist:1'},
      {id:'p2',name:'Random 500',path:'/media/music/Playlists/Random 500.smartpl',uri:'library:playlist:2'},
      {id:'p3',name:'Morning',path:'/media/music/Playlists/Morning.m3u',uri:'library:playlist:3'},
      {id:'r1',name:'Naxi Radio',path:'/media/music/Radio/Naxi Radio.m3u',uri:'library:playlist:11'},
      {id:'r2',name:'Radio S1',path:'/media/music/Radio/Radio S1.m3u',uri:'library:playlist:12'},
      {id:'r3',name:'Radio Beograd 202',path:'/media/music/Radio/Radio 202.m3u',uri:'library:playlist:13'},
      {id:'r4',name:'Rock Radio',path:'/media/music/Radio/Rock Radio.m3u',uri:'library:playlist:14'}
    ],
    albums:[['Dummy','Portishead'],['Mezzanine','Massive Attack'],['Kind of Blue','Miles Davis'],['Grace','Jeff Buckley'],['The Dark Side of the Moon','Pink Floyd'],['Blue Lines','Massive Attack'],['Moon Safari','Air'],['Back to Black','Amy Winehouse'],['In Rainbows','Radiohead'],['Rumours','Fleetwood Mac'],['Discovery','Daft Punk'],['Songs of Leonard Cohen','Leonard Cohen']].map((x,i)=>({id:`a${i}`,name:x[0],artist:x[1],uri:`library:album:${i}`}))
  };

  function apiUrl(path){const base=String(cfg.apiBase||'/api').replace(/\/$/,'');return `${base}${path.startsWith('/')?path:`/${path}`}`;}
  async function request(path,options={}){const init=Object.assign({headers:{}},options);if(init.body&&typeof init.body!=='string'){init.headers['Content-Type']='application/json';init.body=JSON.stringify(init.body);}const response=await fetch(apiUrl(path),init);if(!response.ok)throw new Error(`${response.status} ${response.statusText}`);if(response.status===204)return null;const text=await response.text();return text?JSON.parse(text):null;}
  function serverOrigin(){try{const api=new URL(apiUrl('/'),window.location.href);return api.pathname.includes('/api')?`${api.origin}${api.pathname.split('/api')[0]}`:api.origin;}catch(_){return window.location.origin;}}
  function artworkUrl(value,max=900){if(!value)return '';if(/^https?:\/\//i.test(value))return value;const sep=value.includes('?')?'&':'?';return `${serverOrigin()}${value.startsWith('/')?'':'/'}${value}${sep}maxwidth=${max}&maxheight=${max}`;}
  function fmtTime(ms){const total=Math.max(0,Math.floor((Number(ms)||0)/1000));return `${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;}
  function toast(message){els.toast.textContent=message;els.toast.classList.add('show');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>els.toast.classList.remove('show'),2200);}
  function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));}
  function isRadioPlaylist(p){const path=String(p.path||'').toLowerCase();const hint=String(cfg.radioPathHint||'/Radio/').toLowerCase();return path.includes(hint)||/(^|\s)(radio|naxi|s1|202|lola)(\s|$)/i.test(p.name||'');}
  function isRadioCurrent(item){return item&&(item.data_kind==='url'||/^https?:\/\//i.test(item.path||''));}
  function qualityText(item){if(!item)return '—';const type=String(item.type||'').toUpperCase();const bitrate=String(item.bitrate||'').trim();if(type==='FLAC'||type==='ALAC')return type;if(bitrate)return `${type||'AUDIO'} ${bitrate}${/^\d+$/.test(bitrate)?'k':''}`;return type||(isRadioCurrent(item)?'STREAM':'AUDIO');}
  function selectedOutput(){
    const currentSelected = els.outputSelect?.value;
    if (currentSelected) {
      const found = state.outputs.find(o => String(o.id) === String(currentSelected));
      if (found) return found;
    }
    return state.outputs.find(o=>o.selected)||state.outputs.find(o=>String(o.name).toLowerCase().includes(String(cfg.preferredOutput).toLowerCase()))||state.outputs[0]||null;
  }

  async function loadInitial(){
    try{
      const [player,currentQueue,outputs,playlists,albums,library,serverConfig]=await Promise.all([
        request('/player'),request('/queue?id=now_playing'),request('/outputs'),request('/library/playlists?limit=500'),request('/library/albums?limit=24'),request('/library'),request('/config')
      ]);
      state.online=true;state.demo=false;state.player=player||state.player;state.current=currentQueue?.items?.[0]||null;state.outputs=outputs?.outputs||[];state.playlists=playlists?.items||[];state.albums=albums?.items||[];state.library=library||null;state.config=serverConfig||null;state.radioPlaylists=state.playlists.filter(isRadioPlaylist);if(isRadioCurrent(state.current))state.mode='radio';renderAll();pollLater();
    }catch(err){console.warn('OwnTone connection failed:',err);if(cfg.demoOnFailure)activateDemo();else{state.online=false;renderAll();}pollLater();}
  }

  function activateDemo(){state.online=false;state.demo=true;state.player={...demo.player};state.current={...demo.current};state.outputs=demo.outputs.map(x=>({...x}));state.playlists=demo.playlists.map(x=>({...x}));state.radioPlaylists=state.playlists.filter(isRadioPlaylist);state.albums=demo.albums.map(x=>({...x}));state.library={...demo.library};state.config={version:'Demo'};renderAll();}
  let pollHandle;
  function pollLater(){clearTimeout(pollHandle);pollHandle=setTimeout(refreshPlayback,Math.max(1500,Number(cfg.pollMs)||3000));}
  async function refreshPlayback(){if(state.demo){pollLater();return;}try{const [player,currentQueue,outputs]=await Promise.all([request('/player'),request('/queue?id=now_playing'),request('/outputs')]);state.online=true;state.player=player||state.player;state.current=currentQueue?.items?.[0]||null;state.outputs=outputs?.outputs||state.outputs;renderPlayer();renderConnection();}catch(err){state.online=false;renderConnection();}finally{pollLater();}}
  async function refreshLibrary(){if(state.demo){toast('Demo mode — connect the LXC to refresh');return;}try{const [playlists,albums,library]=await Promise.all([request('/library/playlists?limit=500'),request('/library/albums?limit=24'),request('/library')]);state.playlists=playlists?.items||[];state.radioPlaylists=state.playlists.filter(isRadioPlaylist);state.albums=albums?.items||[];state.library=library;renderLibrary();renderRadio();toast('Library refreshed');}catch(err){toast(`Refresh failed: ${err.message}`);}}

  function renderAll(){renderMode();renderConnection();renderPlayer();renderLibrary();renderRadio();renderLiveText();}
  function renderMode(){const radio=state.mode==='radio';document.body.classList.toggle('radio-mode',radio);els.musicView.hidden=radio;els.radioView.hidden=!radio;els.modeToggleIcon.innerHTML=radio?icons.note:icons.radio;els.modeToggleLabel.textContent=radio?'Music':'Radio';els.modeToggle.setAttribute('aria-label',radio?'Open music library':'Open radio');els.modeToggle.title=radio?'Open music library':'Open radio';els.playerKicker.textContent=radio?'LIVE NOW':'NOW PLAYING';}
  function renderConnection(){els.connectionText.textContent=state.demo?'Preview mode · connect OwnTone':state.online?'OwnTone connected':'OwnTone offline';els.serverVersion.textContent=state.config?.version?`OwnTone ${state.config.version}`:'OwnTone API';}

  function renderPlayer(){
    const p=state.player||{},item=state.current,out=selectedOutput(),playing=p.state==='play',radio=state.mode==='radio';
    els.playIcon.innerHTML=playing?icons.pause:icons.play;els.playButton.setAttribute('aria-label',playing?'Pause':'Play');els.statusDot.classList.toggle('on',!!out?.selected&&(state.online||state.demo));els.outputName.textContent=out?.name||'No output';
    if(item){els.trackTitle.textContent=item.title||(radio?'Live Radio':'Unknown track');els.trackArtist.textContent=item.artist||(radio?item.album||'Internet Radio':'Unknown artist');const bits=[];if(!radio&&item.album)bits.push(item.album);if(item.year)bits.push(item.year);if(radio&&item.album&&item.artist)bits.push(item.album);bits.push(qualityText(item));els.trackMeta.textContent=bits.filter(Boolean).join(' · ');els.formatPill.textContent=qualityText(item);const art=artworkUrl(item.artwork_url);if(art){els.artwork.src=art;els.artwork.onload=()=>els.playerArt.classList.add('has-art');els.artwork.onerror=()=>els.playerArt.classList.remove('has-art');}else{els.artwork.removeAttribute('src');els.playerArt.classList.remove('has-art');}}
    else{els.trackTitle.textContent=radio?'Choose a station.':'Choose something to play.';els.trackArtist.textContent='OwnTone';els.trackMeta.textContent=radio?'Your saved radio streams':'Your local music library';els.formatPill.textContent=radio?'STREAM':'READY';els.playerArt.classList.remove('has-art');}
    const len=Number(p.item_length_ms||item?.length_ms||0),pos=Number(p.item_progress_ms||0);if(!state.seekDragging){const ratio=len>0?Math.min(1,Math.max(0,pos/len)):0;els.progressRange.value=Math.round(ratio*1000);els.progressRange.style.setProperty('--range-progress',`${ratio*100}%`);els.elapsedTime.textContent=fmtTime(pos);els.remainingTime.textContent=`−${fmtTime(Math.max(0,len-pos))}`;}els.progressRange.disabled=!len||radio;
    if(!state.volumeDragging && (Date.now() - state.lastVolumeChangeTime > 3500)){const volume=Number(out?.volume??p.volume??0);els.volumeRange.value=volume;els.volumeRange.style.setProperty('--range-progress',`${volume}%`);els.volumeValue.textContent=`${volume}%`;}
    const old=els.outputSelect.value;els.outputSelect.innerHTML=state.outputs.length?state.outputs.map(o=>`<option value="${escapeHtml(o.id)}" ${o.selected?'selected':''}>${escapeHtml(o.name)} · ${escapeHtml(o.type)}</option>`).join(''):'<option value="">No output</option>';if(old&&state.outputs.some(o=>String(o.id)===String(old)))els.outputSelect.value=old;
    renderLiveText();
  }

  function renderLiveText(){
    const el=document.getElementById('radioLiveText');if(!el)return;
    const radio=state.mode==='radio',item=state.current;
    if(radio&&item){
      const station=item.title||'Live Radio';
      const text=[item.artist,item.album].filter(Boolean).join(' · ');
      const art=artworkUrl(item.artwork_url);if(art){el.innerHTML=`<div class="radio-live-card"><img class="radio-live-art" src="${escapeHtml(art)}" alt="" onerror="this.remove()"><div><span class="radio-live-station">${escapeHtml(station)}</span><span class="radio-live-text">${escapeHtml(text)||'Tuning in…'}</span></div></div>`;}
      else el.innerHTML=`<div class="radio-live-card"><div class="radio-live-mark">LIVE</div><div><span class="radio-live-station">${escapeHtml(station)}</span><span class="radio-live-text">${escapeHtml(text)||'Tuning in…'}</span></div></div>`;
    }else{el.innerHTML='<div class="radio-live-empty">Choose a station to see its live text.</div>';}
  }

  function renderLibrary(){
    const stats=state.library;els.libraryCount.textContent=stats?`${Number(stats.albums||0).toLocaleString()} albums · ${Number(stats.songs||0).toLocaleString()} tracks`:'—';
    els.albumGrid.innerHTML=state.albums.length?state.albums.map(album=>{const art=artworkUrl(album.artwork_url,420);return `<button class="album-card" type="button" data-uri="${escapeHtml(album.uri)}" title="Play ${escapeHtml(album.name)}"><div class="album-art">${art?`<img src="${escapeHtml(art)}" alt="" loading="lazy" onerror="this.style.display='none'">`:'<div class="mini-record"></div>'}</div><div class="album-copy"><b>${escapeHtml(album.name)}</b><small>${escapeHtml(album.artist||'Unknown artist')}</small></div></button>`;}).join(''):'<p class="empty-state">No albums found.</p>';
    const normal=state.playlists.filter(p=>!isRadioPlaylist(p)&&!p.folder).slice(0,16);els.playlistGrid.innerHTML=normal.length?normal.map((p,i)=>`<button class="playlist-card" type="button" data-uri="${escapeHtml(p.uri)}"><span class="playlist-badge">${escapeHtml(String(i+1).padStart(2,'0'))}</span><span class="playlist-copy"><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.smart_playlist?'Smart playlist':'Playlist')}</small></span></button>`).join(''):'<p class="empty-state">No playlists found.</p>';
  }
  function renderRadio(){const stations=state.radioPlaylists;els.radioGrid.innerHTML=stations.length?stations.map((p,i)=>`<button class="radio-card" type="button" data-uri="${escapeHtml(p.uri)}" title="${escapeHtml(p.name)}"><span class="radio-card-top"><span class="radio-card-badges"><span class="radio-health-pill" data-status="checking">LIVE</span><span class="radio-quality-pill">STREAM</span></span><span class="radio-card-actions"><span class="radio-drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span><span class="radio-favorite" title="Pin favorite station">♡</span></span></span><span class="radio-card-body"><b class="radio-station-name">${escapeHtml(p.name)}</b><small class="radio-station-sub">OwnTone radio preset</small></span><span class="radio-card-foot"><span class="radio-play-btn">${icons.smallPlay}</span></span></button>`).join(''):`<div class="empty-state">No radio playlists found. Put station M3U files under a path containing <b>${escapeHtml(cfg.radioPathHint)}</b> and refresh the OwnTone library.</div>`;}

  async function playerCommand(command){if(state.demo){demoCommand(command);return;}try{await request(`/player/${command}`,{method:'PUT'});await refreshPlayback();}catch(err){toast(`Playback failed: ${err.message}`);}}
  function demoCommand(command){if(command==='toggle')state.player.state=state.player.state==='play'?'pause':'play';if(command==='play')state.player.state='play';if(command==='pause')state.player.state='pause';if(command==='stop')state.player.state='stop';if(command==='next')state.current={...demo.current,title:'Riders on the Storm',artist:'The Doors',album:'L.A. Woman'};if(command==='previous')state.current={...demo.current,title:'Teardrop',artist:'Massive Attack',album:'Mezzanine'};renderPlayer();}
  async function playUri(uri,{shuffle=false}={}){if(!uri)return;if(state.demo){const playlist=state.playlists.find(p=>p.uri===uri),album=state.albums.find(a=>a.uri===uri);if(playlist&&isRadioPlaylist(playlist)){state.mode='radio';state.current={title:playlist.name,artist:'Live Radio',album:'Direct stream',data_kind:'url',type:'aac',bitrate:'256'};}else if(album){state.mode='music';state.current={title:album.name,artist:album.artist,album:album.name,data_kind:'file',type:'flac',bitrate:'Lossless'};}else if(playlist){state.mode='music';state.current={title:playlist.name,artist:'Playlist',album:'OwnTone',data_kind:'file',type:'flac',bitrate:'Lossless'};}state.player.state='play';renderAll();toast('Preview playback');return;}try{const slider=Number(els.volumeRange.value||0);if(slider>0){const out=selectedOutput();if(out?.id!=null){const v=new URLSearchParams({volume:String(slider),output_id:String(out.id)});await request(`/player/volume?${v}`,{method:'PUT'});}}const qs=new URLSearchParams({uris:uri,clear:'true',playback:'start',shuffle:String(shuffle)});await request(`/queue/items/add?${qs}`,{method:'POST'});await refreshPlayback();}catch(err){toast(`Could not play: ${err.message}`);}}
  async function playPlaylistByName(name){const p=state.playlists.find(x=>String(x.name).toLowerCase()===String(name).toLowerCase());if(!p){toast(`${name} playlist not found`);return;}await playUri(p.uri,{shuffle:/random|morning|favorites/i.test(name)});}
  async function shuffleLibrary(){if(state.demo){state.current={title:'Shuffle all music',artist:'8,283 tracks',album:'Your library',data_kind:'file',type:'flac',bitrate:'Lossless'};state.player.state='play';renderPlayer();toast('Library shuffled');return;}try{const slider=Number(els.volumeRange.value||0);if(slider>0){const out=selectedOutput();if(out?.id!=null){const v=new URLSearchParams({volume:String(slider),output_id:String(out.id)});await request(`/player/volume?${v}`,{method:'PUT'});}}const qs=new URLSearchParams({expression:'media_kind is music AND data_kind is file',clear:'true',playback:'start',shuffle:'true',limit:'500'});await request(`/queue/items/add?${qs}`,{method:'POST'});await refreshPlayback();}catch(err){toast(`Shuffle failed: ${err.message}`);}}
  async function setVolume(value){
    const v = Math.max(0, Math.min(100, Math.round(value)));
    state.lastVolumeChangeTime = Date.now();
    const out=selectedOutput();
    if(out) out.volume = v;
    state.player.volume = v;
    if(state.demo){renderPlayer();return;}
    try{
      const qs=new URLSearchParams({volume:String(v)});
      if(out?.id!=null)qs.set('output_id',String(out.id));
      await request(`/player/volume?${qs}`,{method:'PUT'});
    }catch(err){console.warn('Volume PUT failed:',err);}
  }
  function setVolumeThrottled(value){
    clearTimeout(state.volumeDebounceTimer);
    state.volumeDebounceTimer = setTimeout(()=>setVolume(value), 100);
  }
  async function setOutput(id){if(!id)return;if(state.demo){state.outputs.forEach(o=>o.selected=String(o.id)===String(id));renderPlayer();return;}try{await request('/outputs/set',{method:'PUT',body:{outputs:[String(id)]}});await refreshPlayback();}catch(err){toast(`Output failed: ${err.message}`);}}
  async function seekTo(ratio){const len=Number(state.player?.item_length_ms||state.current?.length_ms||0);if(!len||state.mode==='radio')return;const position=Math.round(Math.max(0,Math.min(1,ratio))*len);if(state.demo){state.player.item_progress_ms=position;renderPlayer();return;}try{await request(`/player/seek?position_ms=${position}`,{method:'PUT'});state.player.item_progress_ms=position;renderPlayer();}catch(err){toast(`Seek failed: ${err.message}`);}}
  function toggleMode(){state.mode=state.mode==='music'?'radio':'music';renderMode();renderPlayer();}

  async function search(query){const q=query.trim();if(!q){els.searchResults.innerHTML='<p class="empty-state">Start typing to search your OwnTone library.</p>';return;}if(state.demo){const pool=[...state.albums.map(x=>({kind:'album',name:x.name,sub:x.artist,uri:x.uri})),...state.playlists.map(x=>({kind:'playlist',name:x.name,sub:'Playlist',uri:x.uri}))].filter(x=>`${x.name} ${x.sub}`.toLowerCase().includes(q.toLowerCase())).slice(0,12);renderSearchResults(pool);return;}try{const qs=new URLSearchParams({query:q,type:'tracks,artists,albums,playlists',media_kind:'music',limit:'8'});const result=await request(`/search?${qs}`);const items=[...(result.tracks?.items||[]).map(x=>({kind:'track',name:x.title,sub:`${x.artist||'Unknown'} · ${x.album||''}`,uri:x.uri})),...(result.albums?.items||[]).map(x=>({kind:'album',name:x.name,sub:x.artist||'Album',uri:x.uri})),...(result.artists?.items||[]).map(x=>({kind:'artist',name:x.name,sub:`${x.track_count||''} tracks`,uri:x.uri})),...(result.playlists?.items||[]).map(x=>({kind:'playlist',name:x.name,sub:'Playlist',uri:x.uri}))];renderSearchResults(items);}catch(err){els.searchResults.innerHTML=`<p class="empty-state">Search failed: ${escapeHtml(err.message)}</p>`;}}
  function renderSearchResults(items){if(!items.length){els.searchResults.innerHTML='<p class="empty-state">Nothing found.</p>';return;}const labels={track:'♪',album:'LP',artist:'A',playlist:'≡'};els.searchResults.innerHTML=items.map(x=>`<button class="search-item" type="button" data-uri="${escapeHtml(x.uri)}"><span class="search-item-icon">${escapeHtml(labels[x.kind]||'♪')}</span><span class="search-item-copy"><b>${escapeHtml(x.name)}</b><small>${escapeHtml(x.sub||x.kind)}</small></span></button>`).join('');}

  els.modeToggle.addEventListener('click',toggleMode);els.playButton.addEventListener('click',()=>playerCommand('toggle'));els.previousButton.addEventListener('click',()=>playerCommand('previous'));els.nextButton.addEventListener('click',()=>playerCommand('next'));els.refreshButton.addEventListener('click',refreshLibrary);els.shuffleLibraryButton.addEventListener('click',shuffleLibrary);
  els.quickGrid.addEventListener('click',e=>{const card=e.target.closest('[data-playlist]');if(card)playPlaylistByName(card.dataset.playlist);});els.albumGrid.addEventListener('click',e=>{const card=e.target.closest('[data-uri]');if(card)playUri(card.dataset.uri);});els.playlistGrid.addEventListener('click',e=>{const card=e.target.closest('[data-uri]');if(card)playUri(card.dataset.uri);});els.radioView.addEventListener('click',e=>{const card=e.target.closest('.radio-card[data-uri]');if(card){state.mode='radio';renderMode();playUri(card.dataset.uri);}});
  els.volumeRange.addEventListener('pointerdown',()=>{state.volumeDragging=true;state.lastVolumeChangeTime=Date.now();});
  els.volumeRange.addEventListener('input',()=>{const v=Number(els.volumeRange.value);state.lastVolumeChangeTime=Date.now();els.volumeRange.style.setProperty('--range-progress',`${v}%`);els.volumeValue.textContent=`${v}%`;setVolumeThrottled(v);});
  els.volumeRange.addEventListener('change',()=>{state.volumeDragging=false;state.lastVolumeChangeTime=Date.now();clearTimeout(state.volumeDebounceTimer);setVolume(Number(els.volumeRange.value));});
  els.volumeRange.addEventListener('pointerup',()=>{state.volumeDragging=false;state.lastVolumeChangeTime=Date.now();clearTimeout(state.volumeDebounceTimer);setVolume(Number(els.volumeRange.value));});
  els.volumeRange.addEventListener('pointercancel',()=>{state.volumeDragging=false;});els.outputSelect.addEventListener('change',()=>setOutput(els.outputSelect.value));
  els.progressRange.addEventListener('pointerdown',()=>{state.seekDragging=true;});els.progressRange.addEventListener('input',()=>{const ratio=Number(els.progressRange.value)/1000;els.progressRange.style.setProperty('--range-progress',`${ratio*100}%`);const len=Number(state.player?.item_length_ms||state.current?.length_ms||0);els.elapsedTime.textContent=fmtTime(len*ratio);els.remainingTime.textContent=`−${fmtTime(len*(1-ratio))}`;});els.progressRange.addEventListener('change',async()=>{const ratio=Number(els.progressRange.value)/1000;await seekTo(ratio);state.seekDragging=false;});els.progressRange.addEventListener('pointerup',()=>{state.seekDragging=false;});
  els.searchButton.addEventListener('click',()=>{if(typeof els.searchDialog.showModal==='function')els.searchDialog.showModal();else els.searchDialog.setAttribute('open','');setTimeout(()=>els.searchInput.focus(),60);});els.searchInput.addEventListener('input',()=>{clearTimeout(state.searchTimer);state.searchTimer=setTimeout(()=>search(els.searchInput.value),220);});els.searchResults.addEventListener('click',e=>{const item=e.target.closest('[data-uri]');if(!item)return;playUri(item.dataset.uri);els.searchDialog.close?.();});els.searchForm.addEventListener('submit',e=>{if(e.submitter?.value!=='cancel')e.preventDefault();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.demo)refreshPlayback();});
  renderMode();loadInitial();
})();

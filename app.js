(() => {
  'use strict';

  const cfg = Object.assign({ apiBase:'/api', demoOnFailure:true, pollMs:3000, fallbackPollMs:15000, websocketPath:'/owntone-events', websocketReconnectMs:2500, radioPathHint:'/Radio/', preferredOutput:'HomePod' }, window.OWNTONE_DASHBOARD || {});
  const $ = (id) => document.getElementById(id);
  const els = {
    connectionText:$('connectionText'), modeToggle:$('modeToggle'), modeToggleIcon:$('modeToggleIcon'), modeToggleLabel:$('modeToggleLabel'), searchButton:$('searchButton'),
    playerArt:$('playerArt'), artwork:$('artwork'), formatPill:$('formatPill'), playerKicker:$('playerKicker'), statusDot:$('statusDot'), outputName:$('outputName'),
    trackTitle:$('trackTitle'), trackArtist:$('trackArtist'), trackMeta:$('trackMeta'), trackChips:$('trackChips'), previousButton:$('previousButton'), playButton:$('playButton'), playIcon:$('playIcon'), nextButton:$('nextButton'),
    progressRange:$('progressRange'), elapsedTime:$('elapsedTime'), remainingTime:$('remainingTime'), volumeRange:$('volumeRange'), volumeValue:$('volumeValue'), outputSelect:$('outputSelect'),
    musicView:$('musicView'), radioView:$('radioView'), quickGrid:$('quickGrid'), refreshButton:$('refreshButton'), shuffleLibraryButton:$('shuffleLibraryButton'), libraryCount:$('libraryCount'),
    albumGrid:$('albumGrid'), playlistGrid:$('playlistGrid'), radioGrid:$('radioGrid'), serverVersion:$('serverVersion'), searchDialog:$('searchDialog'), searchForm:$('searchForm'), searchInput:$('searchInput'), searchResults:$('searchResults'), toast:$('toast')
  };

  const icons = {
    play:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>',
    pause:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM14 5h4v14h-4z"/></svg>',
    radio:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h16v10H4zM7 7l9-4M8 14h.01M12 14h5M12 17h5"/></svg>',
    note:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V6l10-2v12M9 9l10-2M6.5 20A2.5 2.5 0 1 0 6.5 15a2.5 2.5 0 0 0 0 5ZM16.5 18A2.5 2.5 0 1 0 16.5 13a2.5 2.5 0 0 0 0 5Z"/></svg>',
    smallPlay:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>',
    spinner:'<svg class="playback-spinner" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6" opacity="0.25"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-dasharray="16 40" stroke-linecap="round"/></svg>'
  };

  const state = {
    mode:'music', online:false, demo:false,
    player:{state:'stop',volume:25,item_progress_ms:0,item_length_ms:0}, current:null, outputs:[], playlists:[], albums:[], library:null, config:null, radioPlaylists:[],
    seekDragging:false, volumeDragging:false, lastVolumeChangeTime:0, volumeDebounceTimer:null, toastTimer:null, searchTimer:null,
    startingPlayback:false, startingUri:null, startingTimeout:null
  };

  const demo = {
    player:{state:'play',volume:18,item_progress_ms:126000,item_length_ms:306000,item_id:'demo'},
    current:{id:'demo',title:'La Vie En Rose',artist:'Grace Jones',album:'Portfolio',type:'flac',bitrate:'Lossless',samplerate:'44100',data_kind:'file'},
    outputs:[{id:'hp',name:'HomePod mini',type:'AirPlay',selected:true,volume:18}], library:{songs:8283,albums:714,artists:489},
    playlists:[
      {id:'p1',name:'Favorites',path:'/media/music/Playlists/Favorites.smartpl',uri:'library:playlist:1'},
      {id:'p2',name:'Random 500',path:'/media/music/Playlists/Random 500.smartpl',uri:'library:playlist:2'},
      {id:'p3',name:'Morning',path:'/media/music/Playlists/Morning.m3u',uri:'library:playlist:3'},
      {id:'r1',name:'KEXP 90.3',path:'/media/music/Radio/KEXP 90.3.m3u',uri:'library:playlist:11'},
      {id:'r2',name:'BBC Radio 1',path:'/media/music/Radio/BBC Radio 1.m3u',uri:'library:playlist:12'},
      {id:'r3',name:'FIP',path:'/media/music/Radio/FIP.m3u',uri:'library:playlist:13'},
      {id:'r4',name:'Jazz FM',path:'/media/music/Radio/Jazz FM.m3u',uri:'library:playlist:14'},
      {id:'r5',name:'Radio Paradise',path:'/media/music/Radio/Radio Paradise.m3u',uri:'library:playlist:15'},
      {id:'r6',name:'Triple J',path:'/media/music/Radio/Triple J.m3u',uri:'library:playlist:16'}
    ],
    albums:[['Dummy','Portishead'],['Mezzanine','Massive Attack'],['Kind of Blue','Miles Davis'],['Grace','Jeff Buckley'],['The Dark Side of the Moon','Pink Floyd'],['Blue Lines','Massive Attack'],['Moon Safari','Air'],['Back to Black','Amy Winehouse'],['In Rainbows','Radiohead'],['Rumours','Fleetwood Mac'],['Discovery','Daft Punk'],['Songs of Leonard Cohen','Leonard Cohen']].map((x,i)=>({id:`a${i}`,name:x[0],artist:x[1],uri:`library:album:${i}`}))
  };

  function apiUrl(path){const base=String(cfg.apiBase||'/api').replace(/\/$/,'');return `${base}${path.startsWith('/')?path:`/${path}`}`;}
  async function request(path,options={}){const init=Object.assign({headers:{},cache:'no-store'},options);if(init.body&&typeof init.body!=='string'){init.headers['Content-Type']='application/json';init.body=JSON.stringify(init.body);}const response=await fetch(apiUrl(path),init);if(!response.ok)throw new Error(`${response.status} ${response.statusText}`);if(response.status===204)return null;const text=await response.text();return text?JSON.parse(text):null;}
  function serverOrigin(){try{const api=new URL(apiUrl('/'),window.location.href);return api.pathname.includes('/api')?`${api.origin}${api.pathname.split('/api')[0]}`:api.origin;}catch(_){return window.location.origin;}}
  function artworkUrl(value,max=900){if(!value)return '';if(/^(?:https?:|data:|blob:)/i.test(value))return value;const normalized=String(value).replace(/^\.\//,'/');const sep=normalized.includes('?')?'&':'?';return `${serverOrigin()}${normalized.startsWith('/')?'':'/'}${normalized}${sep}maxwidth=${max}&maxheight=${max}`;}
  function queueItemForPlayer(player,payload){
    const items=Array.isArray(payload?.items)?payload.items:[];
    if(player?.item_id!=null){const id=String(player.item_id);return items.find(item=>[item.id,item.track_id].some(value=>value!=null&&String(value)===id))||null;}
    return items[0]||null;
  }
  async function resolveCurrentItem(player,currentQueue){
    const direct=queueItemForPlayer(player,currentQueue);
    const isStream=direct?.data_kind==='url'||/^https?:\/\//i.test(direct?.path||'');
    const needsRecovery=!direct||!direct.title||(!direct.artwork_url&&direct.track_id==null&&!isStream)||(!direct.artist&&!isStream);
    if(needsRecovery&&player?.item_id!=null){
      const fullQueue=await request('/queue?start=0&end=500').catch(()=>null);
      const recovered=queueItemForPlayer(player,fullQueue);
      if(recovered)return recovered;
    }
    if(direct)return direct;
    if(player?.item_id!=null&&state.current&&[state.current.id,state.current.track_id].some(value=>value!=null&&String(value)===String(player.item_id)))return state.current;
    return null;
  }
  function filenameStem(path){const name=String(path||'').split('/').filter(Boolean).pop()||'';return name.replace(/\.[^.]+$/,'').replace(/^\d+[\s._-]+/,'').trim();}
  function trackTitle(item,radio){return item?.title||item?.name||filenameStem(item?.path)||(radio?'Live Radio':'Unknown track');}
  function trackArtist(item,radio){return item?.artist||item?.album_artist||(radio?item?.album||'Internet Radio':'Unknown artist');}
  function normalizedArtworkMapValue(item){
    const map=cfg.radioArtwork||{};
    const names=[item?.title,item?.name,item?.artist,item?.album].filter(Boolean).map(value=>String(value).trim().toLowerCase());
    for(const [name,value] of Object.entries(map)){const key=String(name).trim().toLowerCase();if(names.includes(key))return value;}
    return '';
  }
  function fallbackArtwork(item,radio){
    const title=trackTitle(item,radio),artist=trackArtist(item,radio);
    const words=String(title||artist||'OwnTone').replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).filter(Boolean);
    const initials=(words.slice(0,2).map(word=>word[0]).join('')||'OT').toUpperCase();
    let hash=0;for(const char of `${title}|${artist}`)hash=((hash*31)+char.charCodeAt(0))|0;
    const hue=Math.abs(hash)%360, hue2=(hue+68)%360;
    const xml=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 72% 58%)"/><stop offset="1" stop-color="hsl(${hue2} 34% 16%)"/></linearGradient></defs><rect width="1000" height="1000" fill="url(#g)"/><circle cx="500" cy="500" r="290" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="8"/><circle cx="500" cy="500" r="190" fill="none" stroke="rgba(255,255,255,.13)" stroke-width="8"/><text x="500" y="548" text-anchor="middle" fill="white" font-family="Arial,sans-serif" font-size="190" font-weight="800" letter-spacing="-12">${escapeHtml(initials)}</text><text x="500" y="870" text-anchor="middle" fill="rgba(255,255,255,.72)" font-family="Arial,sans-serif" font-size="28" font-weight="700" letter-spacing="5">${escapeHtml(radio?'LIVE RADIO':'OWNTONE')}</text></svg>`;
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(xml)}`;
  }
  function artworkCandidates(item,player){
    if(!item)return [];
    const values=[item.artwork_url,item.track_id!=null?`/artwork/item/${encodeURIComponent(item.track_id)}`:'',player?.artwork_url,normalizedArtworkMapValue(item),fallbackArtwork(item,isRadioCurrent(item))];
    const key=item.id??item.track_id??player?.item_id;
    return [...new Set(values.filter(Boolean))].map(value=>{
      const url=artworkUrl(value);
      return key==null||/^(?:data:|blob:)/i.test(url)?url:`${url}${url.includes('?')?'&':'?'}track=${encodeURIComponent(key)}`;
    });
  }
  function setPlayerArtwork(item,player){
    const candidates=artworkCandidates(item,player);
    const token=`${player?.item_id??item?.id??''}|${candidates.join('|')}`;
    if(els.artwork.dataset.artworkToken===token){if(candidates.length&&els.artwork.complete&&els.artwork.naturalWidth>0)els.playerArt.classList.add('has-art');return;}
    els.artwork.dataset.artworkToken=token;
    els.playerArt.classList.remove('has-art');
    els.artwork.removeAttribute('src');
    if(!candidates.length){els.playerArt.style.removeProperty('--art-url');return;}
    let index=0;
    const loadNext=()=>{
      if(els.artwork.dataset.artworkToken!==token)return;
      const url=candidates[index];
      const wrapEl=els.playerArt.closest('.player-art-wrap')||els.playerArt.parentElement;
      if(wrapEl)wrapEl.style.setProperty('--art-url',`url("${url.replace(/"/g,'%22')}")`);
      els.artwork.onload=()=>{if(els.artwork.dataset.artworkToken!==token)return;if(els.artwork.naturalWidth>0)els.playerArt.classList.add('has-art');else{index+=1;if(index<candidates.length)loadNext();}};
      els.artwork.onerror=()=>{if(els.artwork.dataset.artworkToken!==token)return;index+=1;if(index<candidates.length)loadNext();};
      els.artwork.src=url;
    };
    loadNext();
  }
  function fmtTime(ms){const total=Math.max(0,Math.floor((Number(ms)||0)/1000));return `${Math.floor(total/60)}:${String(total%60).padStart(2,'0')}`;}
  function toast(message){els.toast.textContent=message;els.toast.classList.add('show');clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>els.toast.classList.remove('show'),2200);}
  function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));}
  function isRadioPlaylist(p){const path=String(p.path||'').toLowerCase();const hint=String(cfg.radioPathHint||'/Radio/').toLowerCase();return path.includes(hint)||/(^|\s)(radio|naxi|s1|202|lola)(\s|$)/i.test(p.name||'');}
  function isRadioCurrent(item){return item&&(item.data_kind==='url'||/^https?:\/\//i.test(item.path||''));}
  function qualityText(item){if(!item)return '—';const type=String(item.type||'').toUpperCase();const bitrate=String(item.bitrate||'').trim();if(type==='FLAC'||type==='ALAC')return type;if(bitrate)return `${type||'AUDIO'} ${bitrate}${/^\d+$/.test(bitrate)?'k':''}`;return type||(isRadioCurrent(item)?'STREAM':'AUDIO');}
  function sampleRateText(value){const rate=Number(value);if(!Number.isFinite(rate)||rate<=0)return '';if(rate>=1000){const khz=rate/1000;return `${Number.isInteger(khz)?khz:khz.toFixed(1)} kHz`;}return `${rate} Hz`;}
  function bitDepthText(item){const depth=Number(item?.bit_depth??item?.bitdepth??item?.bits_per_sample??item?.sample_size);return Number.isFinite(depth)&&depth>0?`${depth}-bit`:'';}
  function bitrateText(value){const bitrate=Number(value);return Number.isFinite(bitrate)&&bitrate>0?`${Math.round(bitrate)} kbps`:'';}
  function channelsText(value){const channels=Number(value);if(!Number.isFinite(channels)||channels<=0)return '';if(channels===1)return 'Mono';if(channels===2)return 'Stereo';return `${channels} channels`;}
  function megabytesText(bytes,{estimated=false}={}){const value=Number(bytes);if(!Number.isFinite(value)||value<=0)return '';const mb=value/1000000;const formatted=new Intl.NumberFormat(undefined,{maximumFractionDigits:mb>=100?0:1,minimumFractionDigits:mb<10?1:0}).format(mb);return `${estimated?'≈ ':''}${formatted} MB`;}
  function fileSizeText(item){const exact=Number(item?.file_size??item?.file_size_bytes??item?.filesize??item?.size_bytes);if(Number.isFinite(exact)&&exact>0)return megabytesText(exact);const bitrate=Number(item?.bitrate),length=Number(item?.length_ms||state.player?.item_length_ms);if(isRadioCurrent(item)||!Number.isFinite(bitrate)||bitrate<=0||!Number.isFinite(length)||length<=0)return '';return megabytesText((bitrate*length)/8,{estimated:true});}
  function renderTrackChips(item,radio){if(!els.trackChips)return;const chips=item?[String(item.type||'').toUpperCase(),sampleRateText(item.samplerate),bitDepthText(item),bitrateText(item.bitrate),channelsText(item.channels),radio?'':fileSizeText(item)].filter(Boolean):[];els.trackChips.innerHTML=chips.map(value=>`<span class="track-chip">${escapeHtml(value)}</span>`).join('');els.trackChips.hidden=!chips.length;}
  function browserOutput(){return window.OWNTONE_BROWSER_OUTPUT?.getState?.()||null;}
  function selectedOutput(){
    const browser=browserOutput();
    if(browser?.active)return browser;
    const currentSelected = els.outputSelect?.value;
    if (currentSelected) {
      const found = state.outputs.find(o => String(o.id) === String(currentSelected));
      if (found) return found;
    }
    return state.outputs.find(o=>o.selected)||state.outputs.find(o=>String(o.name).toLowerCase().includes(String(cfg.preferredOutput).toLowerCase()))||state.outputs[0]||null;
  }

  function startPlaybackFeedback(uri, title){
    state.startingPlayback = true;
    state.startingUri = uri || null;
    clearTimeout(state.startingTimeout);
    state.startingTimeout = setTimeout(() => {
      state.startingPlayback = false;
      state.startingUri = null;
      renderPlayer();
    }, 11000);
    if(title) toast(`Connecting to ${title}…`);
    renderPlayer();
    document.querySelectorAll('.radio-card').forEach(card => {
      const isThis = uri && card.dataset.uri === uri;
      card.classList.toggle('is-starting', isThis);
      if (isThis) {
        const playBtn = card.querySelector('.radio-play-btn');
        if (playBtn) playBtn.innerHTML = `<svg class="radio-card-spinner" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.8" opacity="0.25"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.8" stroke-dasharray="16 40" stroke-linecap="round"/></svg>`;
      }
    });
  }

  function clearPlaybackFeedback(){
    state.startingPlayback = false;
    state.startingUri = null;
    clearTimeout(state.startingTimeout);
    document.querySelectorAll('.radio-card.is-starting').forEach(card => {
      card.classList.remove('is-starting');
      const playBtn = card.querySelector('.radio-play-btn');
      if (playBtn) playBtn.innerHTML = icons.smallPlay;
    });
  }

  async function loadInitial(){
    try{
      const [player,currentQueue,outputs,playlists,albums,library,serverConfig]=await Promise.all([
        request('/player'),request('/queue?id=now_playing'),request('/outputs'),request('/library/playlists?limit=500'),request('/library/albums?limit=24'),request('/library'),request('/config')
      ]);
      state.online=true;state.demo=false;state.player=player||state.player;state.current=await resolveCurrentItem(state.player,currentQueue);state.outputs=outputs?.outputs||[];state.playlists=playlists?.items||[];state.albums=albums?.items||[];state.library=library||null;state.config=serverConfig||null;state.radioPlaylists=state.playlists.filter(isRadioPlaylist);if(isRadioCurrent(state.current))state.mode='radio';renderAll();connectRealtime();pollLater();
    }catch(err){console.warn('OwnTone connection failed:',err);if(cfg.demoOnFailure)activateDemo();else{state.online=false;renderAll();}pollLater();}
  }

  function activateDemo(){state.online=false;state.demo=true;state.player={...demo.player};state.current={...demo.current};state.outputs=demo.outputs.map(x=>({...x}));state.playlists=demo.playlists.map(x=>({...x}));state.radioPlaylists=state.playlists.filter(isRadioPlaylist);state.albums=demo.albums.map(x=>({...x}));state.library={...demo.library};state.config={version:'Demo'};renderAll();}
  let pollHandle,playbackRequestId=0,trackTransitionTimer,realtimeSocket,realtimeReconnectHandle,realtimeRefreshTimer,realtimeConnected=false;
  function pollLater(){clearTimeout(pollHandle);const delay=realtimeConnected?Math.max(5000,Number(cfg.fallbackPollMs)||15000):Math.max(1500,Number(cfg.pollMs)||3000);pollHandle=setTimeout(refreshPlayback,delay);}
  function realtimeUrl(){
    if(cfg.websocketUrl)return String(cfg.websocketUrl);
    const url=new URL(window.location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname=String(cfg.websocketPath||'/owntone-events').startsWith('/')?String(cfg.websocketPath||'/owntone-events'):`/${cfg.websocketPath}`;url.search='';url.hash='';return url.toString();
  }
  function scheduleRealtimeRefresh(){
    clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer=setTimeout(()=>{if(!state.demo)refreshPlayback();},180);
  }
  function scheduleRealtimeReconnect(){
    clearTimeout(realtimeReconnectHandle);
    if(state.demo)return;
    realtimeReconnectHandle=setTimeout(connectRealtime,Math.max(1000,Number(cfg.websocketReconnectMs)||2500));
  }
  function connectRealtime(){
    if(state.demo||typeof window.WebSocket!=='function')return;
    if(realtimeSocket&&(realtimeSocket.readyState===WebSocket.CONNECTING||realtimeSocket.readyState===WebSocket.OPEN))return;
    clearTimeout(realtimeReconnectHandle);
    let socket;
    try{socket=new WebSocket(realtimeUrl(),'notify');}catch(_){realtimeConnected=false;scheduleRealtimeReconnect();return;}
    realtimeSocket=socket;
    socket.onopen=()=>{if(realtimeSocket!==socket)return;realtimeConnected=true;try{socket.send(JSON.stringify({notify:['player','queue','outputs','volume','options']}));}catch(_){ }pollLater();};
    socket.onmessage=event=>{if(realtimeSocket!==socket)return;try{const payload=JSON.parse(event.data);const events=Array.isArray(payload?.notify)?payload.notify:[];if(events.some(type=>['player','queue','outputs','volume','options'].includes(type)))scheduleRealtimeRefresh();}catch(_){ }};
    socket.onerror=()=>{if(realtimeSocket===socket)realtimeConnected=false;};
    socket.onclose=()=>{if(realtimeSocket!==socket)return;realtimeConnected=false;realtimeSocket=null;pollLater();scheduleRealtimeReconnect();};
  }
  function playingItemKey(player,item){const value=player?.item_id??item?.id??item?.track_id;return value==null?'':String(value);}
  function animateTrackChange(){const card=document.querySelector('.player-card');if(!card)return;card.classList.remove('track-refreshed');void card.offsetWidth;card.classList.add('track-refreshed');clearTimeout(trackTransitionTimer);trackTransitionTimer=setTimeout(()=>card.classList.remove('track-refreshed'),560);}
  async function refreshPlayback(){if(state.demo){pollLater();return;}const requestId=++playbackRequestId;const previousKey=playingItemKey(state.player,state.current);try{const [player,currentQueue,outputs]=await Promise.all([request('/player'),request('/queue?id=now_playing'),request('/outputs')]);const nextPlayer=player||state.player;const nextCurrent=await resolveCurrentItem(nextPlayer,currentQueue);if(requestId!==playbackRequestId)return;const nextKey=playingItemKey(nextPlayer,nextCurrent);state.online=true;state.player=nextPlayer;state.current=nextCurrent;state.outputs=outputs?.outputs||state.outputs;if(state.player?.state==='play')clearPlaybackFeedback();renderPlayer();renderConnection();if(previousKey&&nextKey&&previousKey!==nextKey)animateTrackChange();}catch(err){if(requestId===playbackRequestId){state.online=false;renderConnection();}}finally{if(requestId===playbackRequestId)pollLater();}}
  async function refreshLibrary(){if(state.demo){toast('Demo mode — connect the LXC to refresh');return;}try{const [playlists,albums,library]=await Promise.all([request('/library/playlists?limit=500'),request('/library/albums?limit=24'),request('/library')]);state.playlists=playlists?.items||[];state.radioPlaylists=state.playlists.filter(isRadioPlaylist);state.albums=albums?.items||[];state.library=library;renderLibrary();renderRadio();toast('Library refreshed');}catch(err){toast(`Refresh failed: ${err.message}`);}}

  function renderAll(){renderMode();renderConnection();renderPlayer();renderLibrary();renderRadio();renderLiveText();}
  function renderMode(){const radio=state.mode==='radio';document.body.classList.toggle('radio-mode',radio);els.musicView.hidden=radio;els.radioView.hidden=!radio;els.modeToggleIcon.innerHTML=radio?icons.note:icons.radio;els.modeToggleLabel.textContent=radio?'Music':'Radio';els.modeToggle.setAttribute('aria-label',radio?'Open music library':'Open radio');els.modeToggle.title=radio?'Open music library':'Open radio';els.playerKicker.textContent=radio?'LIVE NOW':'NOW PLAYING';}
  let buildSuffix='',buildInfoStarted=false;
  function renderConnection(){
    els.connectionText.textContent=state.demo?'Preview mode · connect OwnTone':state.online?'OwnTone connected':'OwnTone offline';
    const base=state.config?.version?`OwnTone ${state.config.version}`:'OwnTone API';
    els.serverVersion.textContent=buildSuffix?`${base} · ${buildSuffix}`:base;
    if(!buildInfoStarted){buildInfoStarted=true;loadBuildInfo();}
  }
  async function loadBuildInfo(){
    const bits=[String(window.OWNTONE_DASHBOARD_BUILD||'')].filter(Boolean);
    try{const r=await fetch('version.json',{cache:'no-store'});if(r.ok){const d=await r.json();const c=String(d.commit||'').slice(0,7);if(c)bits.push(c);}}catch(_){}
    buildSuffix=bits.join(' · ');renderConnection();
  }

  function renderPlayer(){
    const p=state.player||{},item=state.current,out=selectedOutput(),playing=p.state==='play',radio=state.mode==='radio',isStarting=state.startingPlayback;
    const directRadio=isRadioCurrent(item);
    const playerCard=document.querySelector('.player-card');
    if(playerCard){playerCard.classList.toggle('is-playing',playing);playerCard.classList.toggle('is-starting',isStarting);}
    if(isStarting){
      els.playButton.classList.add('is-starting');
      els.playIcon.innerHTML=icons.spinner;
      els.playButton.setAttribute('aria-label','Connecting to stream…');
      els.formatPill.textContent='CONNECTING…';
      els.formatPill.classList.add('is-buffering');
    }else{
      els.playButton.classList.remove('is-starting');
      els.formatPill.classList.remove('is-buffering');
      els.playIcon.innerHTML=playing?icons.pause:icons.play;
      els.playButton.setAttribute('aria-label',playing?'Pause':'Play');
    }
    els.statusDot.classList.toggle('on',!!out?.selected&&(state.online||state.demo));els.outputName.textContent=out?.name||'No output';
    if(item){els.trackTitle.textContent=trackTitle(item,radio);els.trackArtist.textContent=trackArtist(item,radio);const bits=[];if(!radio&&item.album)bits.push(item.album);if(item.year)bits.push(item.year);if(radio&&item.album&&item.artist)bits.push(item.album);els.trackMeta.textContent=bits.filter(Boolean).join(' · ');renderTrackChips(item,radio);if(!isStarting)els.formatPill.textContent=qualityText(item);setPlayerArtwork(item,p);}
    else{els.trackTitle.textContent=playing?'Updating now playing…':radio?'Choose a station.':'Choose something to play.';els.trackArtist.textContent=playing?'OwnTone is syncing':'OwnTone';els.trackMeta.textContent=playing?'Syncing with OwnTone':radio?'Your saved radio streams':'Your local music library';renderTrackChips(null,radio);if(!isStarting)els.formatPill.textContent=playing?'SYNCING…':radio?'STREAM':'READY';setPlayerArtwork(null,p);}
    const len=Number(p.item_length_ms||item?.length_ms||0),pos=Number(p.item_progress_ms||0);if(!state.seekDragging){const ratio=len>0?Math.min(1,Math.max(0,pos/len)):0;els.progressRange.value=Math.round(ratio*1000);els.progressRange.style.setProperty('--range-progress',`${ratio*100}%`);els.elapsedTime.textContent=fmtTime(pos);els.remainingTime.textContent=`−${fmtTime(Math.max(0,len-pos))}`;}els.progressRange.disabled=!len||directRadio;
    if(!state.volumeDragging && (Date.now() - state.lastVolumeChangeTime > 3500)){const volume=Number(out?.volume??p.volume??0);els.volumeRange.value=volume;els.volumeRange.style.setProperty('--range-progress',`${volume}%`);els.volumeValue.textContent=`${volume}%`;}
    const old=els.outputSelect.value;els.outputSelect.innerHTML=state.outputs.length?state.outputs.map(o=>`<option value="${escapeHtml(o.id)}" ${o.selected?'selected':''}>${escapeHtml(o.name)} · ${escapeHtml(o.type)}</option>`).join(''):'<option value="">No output</option>';if(old&&state.outputs.some(o=>String(o.id)===String(old)))els.outputSelect.value=old;
    [els.previousButton,els.nextButton].forEach(button=>{if(!button)return;button.disabled=directRadio;button.title=directRadio?'Live radio has no previous or next track':button===els.previousButton?'Previous track':'Next track';button.setAttribute('aria-label',button.title);});
    renderLiveText();
  }

  function renderLiveText(){
    const el=document.getElementById('radioLiveText');if(!el)return;
    const item=state.current,live=isRadioCurrent(item);
    if(live&&item){
      const station=item.title||'Live Radio';
      const text=[item.artist,item.album].filter(Boolean).join(' · ');
      const art=artworkUrl(item.artwork_url);if(art){el.innerHTML=`<div class="radio-live-card"><img class="radio-live-art" src="${escapeHtml(art)}" alt="" onerror="this.remove()"><div><span class="radio-live-station">${escapeHtml(station)}</span><span class="radio-live-text">${escapeHtml(text)||'Tuning in…'}</span></div></div>`;}
      else el.innerHTML=`<div class="radio-live-card"><div class="radio-live-mark">LIVE</div><div><span class="radio-live-station">${escapeHtml(station)}</span><span class="radio-live-text">${escapeHtml(text)||'Tuning in…'}</span></div></div>`;
    }else{el.innerHTML='<div class="radio-live-empty">No station on air — play a radio stream to see its live text.</div>';}
  }

  function renderLibrary(){
    const stats=state.library;els.libraryCount.textContent=stats?`${Number(stats.albums||0).toLocaleString()} albums · ${Number(stats.songs||0).toLocaleString()} tracks`:'—';
    const seenCovers=new Set();
    const albums=state.albums.filter(album=>{const key=`${(album.name||'').toLowerCase()}|${album.artwork_url||''}`;if(seenCovers.has(key))return false;seenCovers.add(key);return true;});
    els.albumGrid.innerHTML=albums.length?albums.map(album=>{const art=artworkUrl(album.artwork_url,420);return `<button class="album-card" type="button" data-uri="${escapeHtml(album.uri)}" title="Play ${escapeHtml(album.name)}"><div class="album-art">${art?`<img src="${escapeHtml(art)}" alt="" loading="lazy" onerror="this.style.display='none'">`:'<div class="mini-record"></div>'}</div><div class="album-copy"><b>${escapeHtml(album.name)}</b><small>${escapeHtml(album.artist||'Unknown artist')}</small></div></button>`;}).join(''):'<p class="empty-state">No albums found.</p>';
    const normal=state.playlists.filter(p=>!isRadioPlaylist(p)&&!p.folder).slice(0,16);els.playlistGrid.innerHTML=normal.length?normal.map((p,i)=>`<button class="playlist-card" type="button" data-uri="${escapeHtml(p.uri)}"><span class="playlist-badge">${escapeHtml(String(i+1).padStart(2,'0'))}</span><span class="playlist-copy"><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.smart_playlist?'Smart playlist':'Playlist')}</small></span></button>`).join(''):'<p class="empty-state">No playlists found.</p>';
  }
  function renderRadio(){
    const stations=state.radioPlaylists;
    els.radioGrid.innerHTML=stations.length?stations.map((p,i)=>`<div class="radio-card" role="button" tabindex="0" data-uri="${escapeHtml(p.uri)}" title="${escapeHtml(p.name)}"><span class="radio-card-top"><span class="radio-card-badges"><span class="radio-health-pill" data-status="live">LIVE</span><span class="radio-quality-pill">STREAM</span></span><span class="radio-card-actions"><button type="button" class="radio-favorite" title="Pin favorite station">♡</button></span></span><span class="radio-card-body"><b class="radio-station-name">${escapeHtml(p.name)}</b><small class="radio-station-sub">OwnTone radio preset</small></span><span class="radio-card-foot"><span class="radio-play-btn">${icons.smallPlay}</span></span></div>`).join(''):`<div class="empty-state">No radio playlists found. Put station M3U files under a path containing <b>${escapeHtml(cfg.radioPathHint)}</b> and refresh the OwnTone library.</div>`;
    if(typeof window.OWNTONE_ENHANCE_RADIO==='function') window.OWNTONE_ENHANCE_RADIO();
  }

  async function playerCommand(command){
    if((command==='next'||command==='previous')&&isRadioCurrent(state.current)){toast('Live radio has no previous or next track');return;}
    if(command==='play'||(command==='toggle'&&state.player?.state!=='play')){
      startPlaybackFeedback(state.current?.uri, state.current?.title);
    }
    if(state.demo){demoCommand(command);return;}
    try{
      await request(`/player/${command}`,{method:'PUT'});
      await refreshPlayback();
    }catch(err){
      clearPlaybackFeedback();
      toast(`Playback failed: ${err.message}`);
    }
  }
  function demoCommand(command){if(command==='toggle')state.player.state=state.player.state==='play'?'pause':'play';if(command==='play')state.player.state='play';if(command==='pause')state.player.state='pause';if(command==='stop')state.player.state='stop';if(command==='next')state.current={...demo.current,title:'Riders on the Storm',artist:'The Doors',album:'L.A. Woman'};if(command==='previous')state.current={...demo.current,title:'Teardrop',artist:'Massive Attack',album:'Mezzanine'};renderPlayer();}
  async function playUri(uri,{shuffle=false}={}){
    if(!uri)return;
    const station=state.radioPlaylists.find(p=>p.uri===uri);
    const album=state.albums.find(a=>a.uri===uri);
    const playlist=state.playlists.find(p=>p.uri===uri);
    const name=station?.name || album?.name || playlist?.name || '';
    // Playback follows the source: starting a station enters radio view, anything else music view.
    syncPlaybackMode(uri);
    startPlaybackFeedback(uri, name);
    if(state.demo){const playlist=state.playlists.find(p=>p.uri===uri),album=state.albums.find(a=>a.uri===uri);if(playlist&&isRadioPlaylist(playlist)){state.mode='radio';state.current={title:playlist.name,artist:'Live Radio',album:'Direct stream',data_kind:'url',type:'aac',bitrate:'256'};}else if(album){state.mode='music';state.current={title:album.name,artist:album.artist,album:album.name,data_kind:'file',type:'flac',bitrate:'Lossless'};}else if(playlist){state.mode='music';state.current={title:playlist.name,artist:'Playlist',album:'OwnTone',data_kind:'file',type:'flac',bitrate:'Lossless'};}state.player.state='play';clearPlaybackFeedback();renderAll();toast('Preview playback');return;}
    try{
      const slider=Number(els.volumeRange.value||0);
      if(slider>0){
        const out=selectedOutput();
        if(out?.id==='browser') window.OWNTONE_BROWSER_OUTPUT?.setVolume(slider);
        else if(out?.id!=null){
          const v=new URLSearchParams({volume:String(slider),output_id:String(out.id)});
          await request(`/player/volume?${v}`,{method:'PUT'});
        }
      }
      const qs=new URLSearchParams({uris:uri,clear:'true',playback:'start',shuffle:String(shuffle)});
      await request(`/queue/items/add?${qs}`,{method:'POST'});
      await refreshPlayback();
    }catch(err){
      clearPlaybackFeedback();
      toast(`Could not play: ${err.message}`);
    }
  }
  async function playPlaylistByName(name){const p=state.playlists.find(x=>String(x.name).toLowerCase()===String(name).toLowerCase());if(!p){toast(`${name} playlist not found`);return;}await playUri(p.uri,{shuffle:/random|morning|favorites/i.test(name)});}
  async function playExpression(expression,{shuffle=false,label=''}={}){
    if(state.demo){state.current={title:label||'Library',artist:'Preview',album:'OwnTone',data_kind:'file',type:'flac',bitrate:'Lossless'};state.player.state='play';renderPlayer();toast('Preview playback');return;}
    try{
      const slider=Number(els.volumeRange.value||0);
      if(slider>0){
        const out=selectedOutput();
        if(out?.id==='browser')window.OWNTONE_BROWSER_OUTPUT?.setVolume(slider);
        else if(out?.id!=null){const v=new URLSearchParams({volume:String(slider),output_id:String(out.id)});await request(`/player/volume?${v}`,{method:'PUT'});}
      }
      const qs=new URLSearchParams({expression,clear:'true',playback:'start',shuffle:String(!!shuffle)});
      await request(`/queue/items/add?${qs}`,{method:'POST'});
      await refreshPlayback();
    }catch(err){toast(`Playback failed: ${err.message}`);}
  }
  async function shuffleLibrary(){if(state.demo){state.current={title:'Shuffle all music',artist:'8,283 tracks',album:'Your library',data_kind:'file',type:'flac',bitrate:'Lossless'};state.player.state='play';renderPlayer();toast('Library shuffled');return;}await playExpression('media_kind is music AND data_kind is file',{shuffle:true});}
  async function setVolume(value){
    const v = Math.max(0, Math.min(100, Math.round(value)));
    state.lastVolumeChangeTime = Date.now();
    const out=selectedOutput();
    if(out) out.volume = v;
    state.player.volume = v;
    if(out?.id==='browser') { window.OWNTONE_BROWSER_OUTPUT?.setVolume(v); renderPlayer(); return; }
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
  async function seekTo(ratio){const len=Number(state.player?.item_length_ms||state.current?.length_ms||0);if(!len||isRadioCurrent(state.current))return;const position=Math.round(Math.max(0,Math.min(1,ratio))*len);if(state.demo){state.player.item_progress_ms=position;renderPlayer();return;}try{await request(`/player/seek?position_ms=${position}`,{method:'PUT'});state.player.item_progress_ms=position;renderPlayer();}catch(err){toast(`Seek failed: ${err.message}`);}}
  function toggleMode(){state.mode=state.mode==='music'?'radio':'music';renderMode();renderPlayer();}
  function syncPlaybackMode(uri){const isRadio=!!uri&&state.radioPlaylists.some(p=>p.uri===uri);const wanted=isRadio?'radio':'music';if(state.mode!==wanted){state.mode=wanted;renderMode();}}

  async function search(query){const q=query.trim();if(!q){els.searchResults.innerHTML='<p class="empty-state">Start typing to search your OwnTone library.</p>';return;}if(state.demo){const pool=[...state.albums.map(x=>({kind:'album',name:x.name,sub:x.artist,uri:x.uri})),...state.playlists.map(x=>({kind:'playlist',name:x.name,sub:'Playlist',uri:x.uri}))].filter(x=>`${x.name} ${x.sub}`.toLowerCase().includes(q.toLowerCase())).slice(0,12);renderSearchResults(pool);return;}try{const qs=new URLSearchParams({query:q,type:'tracks,artists,albums,playlists',media_kind:'music',limit:'8'});const result=await request(`/search?${qs}`);const items=[...(result.tracks?.items||[]).map(x=>({kind:'track',name:x.title,sub:`${x.artist||'Unknown'} · ${x.album||''}`,uri:x.uri})),...(result.albums?.items||[]).map(x=>({kind:'album',name:x.name,sub:x.artist||'Album',uri:x.uri})),...(result.artists?.items||[]).map(x=>({kind:'artist',name:x.name,sub:`${x.track_count||''} tracks`,uri:x.uri})),...(result.playlists?.items||[]).map(x=>({kind:'playlist',name:x.name,sub:'Playlist',uri:x.uri}))];renderSearchResults(items);}catch(err){els.searchResults.innerHTML=`<p class="empty-state">Search failed: ${escapeHtml(err.message)}</p>`;}}
  function renderSearchResults(items){if(!items.length){els.searchResults.innerHTML='<p class="empty-state">Nothing found.</p>';return;}const labels={track:'♪',album:'LP',artist:'A',playlist:'≡'};els.searchResults.innerHTML=items.map(x=>`<button class="search-item" type="button" data-uri="${escapeHtml(x.uri)}"><span class="search-item-icon">${escapeHtml(labels[x.kind]||'♪')}</span><span class="search-item-copy"><b>${escapeHtml(x.name)}</b><small>${escapeHtml(x.sub||x.kind)}</small></span></button>`).join('');}

  els.modeToggle.addEventListener('click',toggleMode);els.playButton.addEventListener('click',()=>playerCommand('toggle'));els.previousButton.addEventListener('click',()=>playerCommand('previous'));els.nextButton.addEventListener('click',()=>playerCommand('next'));els.refreshButton.addEventListener('click',refreshLibrary);els.shuffleLibraryButton.addEventListener('click',shuffleLibrary);
  els.quickGrid.addEventListener('click',e=>{const card=e.target.closest('[data-playlist]');if(card)playPlaylistByName(card.dataset.playlist);});els.albumGrid.addEventListener('click',e=>{const card=e.target.closest('[data-uri]');if(card)playUri(card.dataset.uri);});els.playlistGrid.addEventListener('click',e=>{const card=e.target.closest('[data-uri]');if(card)playUri(card.dataset.uri);});
  document.addEventListener('click',e=>{
    if(e.target.closest('.radio-favorite,.radio-drag-handle')) return;
    const card=e.target.closest('.radio-card[data-uri]');
    if(card && card.dataset.uri){
      state.mode='radio';
      renderMode();
      playUri(card.dataset.uri);
    }
  });
  document.addEventListener('keydown',e=>{
    if(e.key==='Enter'||e.key===' '){
      const card=e.target.closest?.('.radio-card[data-uri]');
      if(card && card.dataset.uri && !e.target.closest('.radio-favorite,.radio-drag-handle')){
        e.preventDefault();
        state.mode='radio';
        renderMode();
        playUri(card.dataset.uri);
      }
    }
  });
  els.volumeRange.addEventListener('pointerdown',()=>{state.volumeDragging=true;state.lastVolumeChangeTime=Date.now();});
  els.volumeRange.addEventListener('input',()=>{const v=Number(els.volumeRange.value);state.lastVolumeChangeTime=Date.now();els.volumeRange.style.setProperty('--range-progress',`${v}%`);els.volumeValue.textContent=`${v}%`;setVolumeThrottled(v);});
  els.volumeRange.addEventListener('change',()=>{state.volumeDragging=false;state.lastVolumeChangeTime=Date.now();clearTimeout(state.volumeDebounceTimer);setVolume(Number(els.volumeRange.value));});
  els.volumeRange.addEventListener('pointerup',()=>{state.volumeDragging=false;state.lastVolumeChangeTime=Date.now();clearTimeout(state.volumeDebounceTimer);setVolume(Number(els.volumeRange.value));});
  els.volumeRange.addEventListener('pointercancel',()=>{state.volumeDragging=false;});els.outputSelect.addEventListener('change',()=>setOutput(els.outputSelect.value));
  els.progressRange.addEventListener('pointerdown',()=>{state.seekDragging=true;});els.progressRange.addEventListener('input',()=>{const ratio=Number(els.progressRange.value)/1000;els.progressRange.style.setProperty('--range-progress',`${ratio*100}%`);const len=Number(state.player?.item_length_ms||state.current?.length_ms||0);els.elapsedTime.textContent=fmtTime(len*ratio);els.remainingTime.textContent=`−${fmtTime(len*(1-ratio))}`;});els.progressRange.addEventListener('change',async()=>{const ratio=Number(els.progressRange.value)/1000;await seekTo(ratio);state.seekDragging=false;});els.progressRange.addEventListener('pointerup',()=>{state.seekDragging=false;});
  els.searchButton.addEventListener('click',()=>{if(typeof els.searchDialog.showModal==='function')els.searchDialog.showModal();else els.searchDialog.setAttribute('open','');setTimeout(()=>els.searchInput.focus(),60);});els.searchInput.addEventListener('input',()=>{clearTimeout(state.searchTimer);state.searchTimer=setTimeout(()=>search(els.searchInput.value),220);});els.searchResults.addEventListener('click',e=>{const item=e.target.closest('[data-uri]');if(!item)return;playUri(item.dataset.uri);els.searchDialog.close?.();});els.searchForm.addEventListener('submit',e=>{if(e.submitter?.value!=='cancel')e.preventDefault();});
  window.OWNTONE_PLAY_URI = (uri) => { playUri(uri); };
  window.OWNTONE_SYNC_PLAYBACK_MODE = syncPlaybackMode;
  window.OWNTONE_APP = { state, playUri, playExpression, playerCommand, setVolume, seekTo, refreshPlayback, refreshLibrary };
  window.addEventListener('owntone-browser-output-change', () => { renderPlayer(); });

  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!state.demo)refreshPlayback();});
  renderMode();loadInitial();
})();

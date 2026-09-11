const { replay, capturedStones, parseSgf, pointName, gtpPointToCoords } = window.YijingCore;

const baseMoves = [
  [3,15],[15,3],[15,15],[3,3],[5,2],[2,5],[16,6],[16,10],[13,16],[10,16],
  [16,13],[13,14],[10,14],[8,16],[4,16],[5,15],[4,14],[6,16],[2,16],[3,17],
  [2,14],[6,3],[8,3],[6,5],[10,3],[12,3],[11,5],[14,5],[14,7],[12,7],
  [15,8],[10,7],[9,5],[8,7],[7,5],[8,9],[10,9],[6,9],[5,7],[4,9],
  [3,7],[2,9],[5,11],[3,11],[7,11],[9,11],[11,11],[13,11],[13,9],[15,11],
  [11,13],[9,13],[7,13],[5,13],[3,13],[1,12],[1,10],[16,12],[17,14],[15,17],
  [12,17],[9,17]
].map(([x,y], i) => ({ x, y, color: i % 2 ? 'W' : 'B' }));

const demoGames = [
  {id:1,title:'秋季升段赛 · 第 3 轮',folder:'mine',black:'林野',blackRank:'7段',white:'陈星',whiteRank:'6段',date:'2026.08.24',event:'秋季升段赛',result:'白中盘胜',tag:'关键对局',moves:baseMoves},
  {id:2,title:'周末训练局 · 星位攻防',folder:'mine',black:'林野',blackRank:'7段',white:'周屿',whiteRank:'7段',date:'2026.08.20',event:'训练对局',result:'黑胜 3.5目',tag:'布局研究',moves:baseMoves.slice(0,54).map((m,i)=>({...m,x:(m.x+(i>28?1:0))%19}))},
  {id:3,title:'城市联赛 · 半决赛',folder:'professional',black:'顾言',blackRank:'职业初段',white:'林野',whiteRank:'7段',date:'2026.08.12',event:'城市联赛',result:'黑中盘胜',tag:'待复盘',moves:baseMoves.slice(0,48)},
  {id:4,title:'小目低挂定式研究',folder:'mine',black:'林野',blackRank:'7段',white:'AI',whiteRank:'九段',date:'2026.08.08',event:'AI 训练',result:'白胜 5.5目',tag:'布局研究',moves:baseMoves.slice(0,44)},
  {id:5,title:'夏季棋友会 · 第 5 局',folder:'mine',black:'唐宁',blackRank:'6段',white:'林野',whiteRank:'7段',date:'2026.07.30',event:'夏季棋友会',result:'白中盘胜',tag:'关键对局',moves:baseMoves.slice(0,58)},
  {id:6,title:'让先指导棋',folder:'professional',black:'林野',blackRank:'6段',white:'沈老师',whiteRank:'职业二段',date:'2026.07.21',event:'指导棋',result:'白胜 8.5目',tag:'待复盘',moves:baseMoves.slice(0,51)}
];

function loadLocal(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key)); return value === null || value === undefined ? fallback : value; } catch { return fallback; } }
const games = loadLocal('yijing.games', demoGames).map(game => {
  if (game.sgfText) {
    try { return { ...game, ...parseSgf(game.sgfText), title: game.title, folder: game.folder, tag: game.tag, favorite: game.favorite, deleted: game.deleted }; } catch {}
  }
  return { ...game, moves: (game.moves || []).map(move => !move.pass && (move.x < 0 || move.y < 0 || move.x >= 19 || move.y >= 19) ? { color: move.color, pass: true } : move) };
});
const customFolders = loadLocal('yijing.folders', []);
const customTags = loadLocal('yijing.tags', []);

let currentGame = games[0];
let currentMove = 38;
let playing = null;
let showNumbers = true;
let showHeat = true;
let mark = null;
let marking = false;
let analyses = new Map();
let analysisRequest = 0;
let activeFolder = 'all';
let chartMode = 'winrate';
let listMode = 'list';
let libraryFilter = { result: '', favorites: false };
let settings = { positionVisits: 64, fullVisits: 24, criticalThreshold: 10, soundEnabled: true, voiceEnabled: true, volume: 0.55, ...loadLocal('yijing.settings', {}) };
let audioContext = null;
let pendingJudgementMove = null;
let lastSpokenMove = null;

const folderNames = { all: '全部棋谱', recent: '最近复盘', mine: '我的对局', professional: '职业棋谱', trash: '回收站' };
let pendingImports = [];
let modalMode = 'edit';

const $ = id => document.getElementById(id);
const boardCanvas = $('goBoard');
const boardCtx = boardCanvas.getContext('2d');
const chartCanvas = $('winChart');
const chartCtx = chartCanvas.getContext('2d');

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function saveLibrary() { try { localStorage.setItem('yijing.games', JSON.stringify(games)); localStorage.setItem('yijing.folders', JSON.stringify(customFolders)); localStorage.setItem('yijing.tags', JSON.stringify(customTags)); localStorage.setItem('yijing.settings', JSON.stringify(settings)); return true; } catch { showToast('本地存储空间不足，修改仅在本次打开期间有效'); return false; } }
function folderOptions(selected = 'mine') { return [{id:'mine',name:'我的对局'},{id:'professional',name:'职业棋谱'},...customFolders].map(folder=>`<option value="${escapeHtml(folder.id)}" ${folder.id===selected?'selected':''}>${escapeHtml(folder.name)}</option>`).join(''); }
function allTags() { return ['布局研究','关键对局','待复盘',...customTags].filter((tag,index,array)=>array.indexOf(tag)===index); }
function tagOptions(selected = '') { return ['<option value="">无标签</option>',...allTags().map(tag=>`<option value="${escapeHtml(tag)}" ${tag===selected?'selected':''}>${escapeHtml(tag)}</option>`)].join(''); }

function renderTags() {
  const colors=['green','orange','blue'];
  $('tagList').innerHTML=allTags().map((tag,index)=>`<button data-tag="${escapeHtml(tag)}"><i class="dot ${colors[index%3]}"></i>${escapeHtml(tag)}</button>`).join('');
  document.querySelectorAll('.tags button').forEach(button=>button.onclick=()=>{activeFolder='all';renderFolders();$('searchInput').value=button.dataset.tag;renderGames(button.dataset.tag);document.querySelectorAll('.tags button').forEach(item=>item.classList.toggle('active',item===button))});
}

function renderFolders() {
  const items = [
    {id:'all',name:'全部棋谱',icon:'◉',count:games.filter(g=>!g.deleted).length},
    {id:'recent',name:'最近复盘',icon:'◇',count:Math.min(3,games.filter(g=>!g.deleted).length)},
    {id:'mine',name:'我的对局',icon:'□',count:games.filter(g=>g.folder==='mine'&&!g.deleted).length},
    {id:'professional',name:'职业棋谱',icon:'□',count:games.filter(g=>g.folder==='professional'&&!g.deleted).length},
    ...customFolders.map(folder=>({...folder,icon:'□',count:games.filter(g=>g.folder===folder.id&&!g.deleted).length})),
    {id:'trash',name:'回收站',icon:'⌫',count:games.filter(g=>g.deleted).length,muted:true}
  ];
  items.forEach(item=>{folderNames[item.id]=item.name});
  $('folderList').innerHTML=items.map(item=>`<button class="folder ${item.id===activeFolder?'active':''} ${item.muted?'muted':''}" data-folder="${escapeHtml(item.id)}"><span>${item.icon}</span>${escapeHtml(item.name)}<b>${item.count}</b></button>`).join('');
  $('libraryCount').textContent=items[0].count;
  document.querySelectorAll('.folder').forEach(button=>button.onclick=()=>selectFolder(button.dataset.folder));
}

function selectFolder(folder) { activeFolder=folder;document.querySelectorAll('.tags button').forEach(item=>item.classList.remove('active'));$('searchInput').value='';renderFolders();const visible=renderGames();if(visible.length&&!visible.some(game=>game.id===currentGame.id))selectGame(visible[0].id); }

function openGameModal(mode, game = currentGame) {
  modalMode = mode;
  const importing = mode === 'import';
  const source = importing ? pendingImports[0] : game;
  $('gameModalTitle').textContent = importing ? '确认导入信息' : '重命名与分类';
  $('gameModalStep').textContent = importing ? `待导入 ${pendingImports.length} 局` : `${game.black} vs ${game.white}`;
  $('gameNameInput').value = source.title;
  $('gameFolderSelect').innerHTML = folderOptions(source.folder || 'mine');
  $('gameTagSelect').innerHTML = tagOptions(source.tag || '');
  $('gameModalHint').textContent = importing ? `来源：${source.fileName}` : '名称和分类仅保存在本机，可随时再次修改。';
  $('gameSaveButton').textContent = importing ? (pendingImports.length > 1 ? '保存并继续' : '完成导入') : '保存';
  $('deleteGameButton').classList.toggle('hidden', importing);
  if (!importing) $('deleteGameButton').textContent = game.deleted ? '恢复棋谱' : '移到回收站';
  $('gameModal').classList.remove('hidden');
  setTimeout(()=>$('gameNameInput').select(),0);
}

function closeModal(id) { $(id).classList.add('hidden'); if(id==='gameModal'&&modalMode==='import') pendingImports=[]; }

function showToast(message) {
  const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 2300);
}

function renderGames(filter = '') {
  const query = filter.trim().toLowerCase();
  const activeGames = games.filter(game => !game.deleted);
  const recentIds = new Set(activeGames.slice(0, 3).map(game => game.id));
  const folderMatch = game => (activeFolder === 'all' && !game.deleted)
    || (activeFolder === 'recent' && !game.deleted && recentIds.has(game.id))
    || (activeFolder === 'trash' && game.deleted)
    || (!['all','recent','trash'].includes(activeFolder) && !game.deleted && game.folder === activeFolder);
  const resultColor = result => {
    const value = String(result || '').trim().toUpperCase();
    if (value.startsWith('B') || value.startsWith('黑')) return 'black';
    if (value.startsWith('W') || value.startsWith('白')) return 'white';
    return '';
  };
  const visible = games.filter((g, index) => folderMatch(g, index)
    && [g.title,g.black,g.white,g.event,g.tag].join(' ').toLowerCase().includes(query)
    && (!libraryFilter.result || resultColor(g.result) === libraryFilter.result)
    && (!libraryFilter.favorites || g.favorite));
  $('gameCount').textContent = visible.length;
  $('panelTitle').textContent = folderNames[activeFolder] || '棋谱';
  $('breadcrumbFolder').textContent = folderNames[activeFolder] || '棋谱';
  $('gameList').innerHTML = visible.map(g => `<article class="game-card ${g.id===currentGame.id?'active':''}" data-id="${g.id}">
    <div class="date"><span>${escapeHtml(g.date)}</span><em>${g.favorite?'★ ':''}${escapeHtml(g.tag)}</em></div><h3>${escapeHtml(g.title)}</h3>
    <div class="matchup"><i class="mini-stone"></i><span>${escapeHtml(g.black)}</span><b>vs</b><i class="mini-stone white"></i><span>${escapeHtml(g.white)}</span></div>
    <div class="meta"><span>${escapeHtml(g.event)}</span><span>${escapeHtml(g.result)}</span></div></article>`).join('') || '<p style="padding:30px;color:#999;text-align:center">此文件夹中还没有棋谱</p>';
  document.querySelectorAll('.game-card').forEach(card => card.onclick = () => selectGame(Number(card.dataset.id)));
  $('gameList').classList.toggle('grid',listMode==='grid');
  return visible;
}

function selectGame(id) {
  currentGame = games.find(g => g.id === id) || games[0]; currentMove = Math.min(38,currentGame.moves.length); mark = null; marking = false; $('markButton').classList.remove('active'); analyses = new Map(); pendingJudgementMove = null; lastSpokenMove = null;
  $('gameTitle').textContent=currentGame.title; $('blackName').innerHTML=`${currentGame.black} <small>${currentGame.blackRank}</small>`; $('whiteName').innerHTML=`${currentGame.white} <small>${currentGame.whiteRank}</small>`;
  $('favoriteButton').textContent=currentGame.favorite?'★':'☆';$('favoriteButton').classList.toggle('active',Boolean(currentGame.favorite));
  $('moveSlider').max=currentGame.moves.length; $('moveTotal').textContent=currentGame.moves.length;
  renderGames($('searchInput').value); update(); analyzeCurrentPosition();
}

function drawBoard() {
  const ctx=boardCtx,w=boardCanvas.width,pad=43,step=(w-pad*2)/18;
  const gradient=ctx.createLinearGradient(0,0,w,w); gradient.addColorStop(0,'#e7c58d');gradient.addColorStop(.52,'#d9b16f');gradient.addColorStop(1,'#c99c59');ctx.fillStyle=gradient;ctx.fillRect(0,0,w,w);
  ctx.strokeStyle='rgba(64,44,21,.72)';ctx.lineWidth=1.25;
  for(let i=0;i<19;i++){const n=pad+i*step;ctx.beginPath();ctx.moveTo(pad,n);ctx.lineTo(w-pad,n);ctx.stroke();ctx.beginPath();ctx.moveTo(n,pad);ctx.lineTo(n,w-pad);ctx.stroke()}
  ctx.fillStyle='#4f371f';[3,9,15].forEach(x=>[3,9,15].forEach(y=>{ctx.beginPath();ctx.arc(pad+x*step,pad+y*step,4.2,0,Math.PI*2);ctx.fill()}));
  const board=replay(currentGame.moves,currentMove,19,currentGame.setup||[]);
  board.forEach((row,y)=>row.forEach((color,x)=>{if(!color)return;const cx=pad+x*step,cy=pad+y*step,r=step*.45;const g=ctx.createRadialGradient(cx-r*.35,cy-r*.4,1,cx,cy,r);if(color==='B'){g.addColorStop(0,'#555b57');g.addColorStop(.6,'#202521');g.addColorStop(1,'#090b0a')}else{g.addColorStop(0,'#fff');g.addColorStop(.72,'#f1f0eb');g.addColorStop(1,'#c9c7bf')}ctx.fillStyle=g;ctx.shadowColor='#4c321f88';ctx.shadowBlur=4;ctx.shadowOffsetY=2;ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();ctx.shadowColor='transparent';
    if(showNumbers){const idx=currentGame.moves.slice(0,currentMove).map(m=>`${m.x},${m.y}`).lastIndexOf(`${x},${y}`)+1;if(idx){ctx.fillStyle=color==='B'?'#eee':'#333';ctx.font=`600 ${idx>99?11:13}px sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(idx,cx,cy)}}}));
  if(currentMove){const last=currentGame.moves[currentMove-1];if(!last.pass){ctx.strokeStyle='#c95b46';ctx.lineWidth=3;ctx.beginPath();ctx.arc(pad+last.x*step,pad+last.y*step,step*.17,0,Math.PI*2);ctx.stroke()}}
  if(showHeat && currentMove < currentGame.moves.length){candidates().forEach((c,i)=>{const cx=pad+c.x*step,cy=pad+c.y*step;ctx.fillStyle=["#2f7b58cc","#d3983dcc","#b65e4bcc"][i];ctx.beginPath();ctx.arc(cx,cy,step*(.38-i*.05),0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.font='bold 12px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(i+1,cx,cy)})}
  if(mark){ctx.strokeStyle='#c34e3f';ctx.lineWidth=4;ctx.beginPath();ctx.moveTo(pad+mark.x*step, pad+(mark.y-.3)*step);ctx.lineTo(pad+(mark.x-.3)*step,pad+(mark.y+.25)*step);ctx.lineTo(pad+(mark.x+.3)*step,pad+(mark.y+.25)*step);ctx.closePath();ctx.stroke()}
}

function currentAnalysis(){return analyses.get(currentMove)}
function candidates(){return (currentAnalysis()?.moveInfos||[]).slice(0,3).map(info=>({...gtpPointToCoords(info.move),...info})).filter(move=>Number.isInteger(move.x)&&Number.isInteger(move.y))}

function toBlackWin(_result, rate){return rate*100}
function renderCandidates(){const result=currentAnalysis();const moves=candidates();$('candidateList').innerHTML=moves.length?moves.map((c,i)=>`<div class="candidate ${i===0?'active':''}" data-x="${c.x}" data-y="${c.y}"><span class="candidate-index">${i+1}</span><div class="candidate-main"><b>${c.move}</b><span>${i?'候选变化':'KataGo 首选'} · ${c.visits||0} 次访问</span></div><div class="candidate-win"><b>${toBlackWin(result,c.winrate).toFixed(1)}%</b><span>${Number(c.scoreLead||0)>=0?'+':''}${Number(c.scoreLead||0).toFixed(1)} 目</span></div></div>`).join(''):'<div class="empty-analysis">分析后显示推荐着法</div>';document.querySelectorAll('.candidate').forEach(el=>el.onclick=()=>{mark={x:+el.dataset.x,y:+el.dataset.y};drawBoard();showToast(`已在棋盘标出候选点 ${pointName(mark.x,mark.y)}`)})}

function drawChart(){
  const ctx=chartCtx,w=chartCanvas.width,h=chartCanvas.height,p={l:42,r:15,t:15,b:26},max=currentGame.moves.length;
  ctx.clearRect(0,0,w,h);ctx.font='18px "Microsoft YaHei UI"';ctx.fillStyle='#929995';ctx.strokeStyle='#e7e7e2';ctx.lineWidth=1;
  const ticks=chartMode==='winrate'?[0,25,50,75,100]:[-20,-10,0,10,20];
  const toY=value=>chartMode==='winrate'?p.t+(100-value)/100*(h-p.t-p.b):p.t+(20-Math.max(-20,Math.min(20,value)))/40*(h-p.t-p.b);
  ticks.forEach(value=>{const y=toY(value);ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(w-p.r,y);ctx.stroke();ctx.fillText(`${value}${chartMode==='winrate'?'%':''}`,0,y+5)});
  const points=[...analyses.values()].map(result=>({turn:result.turnNumber,value:chartMode==='winrate'?toBlackWin(result,result.rootInfo.winrate):Number(result.rootInfo.scoreLead||0)})).sort((a,b)=>a.turn-b.turn);
  if(points.length){ctx.beginPath();points.forEach((point,index)=>{const x=p.l+point.turn/max*(w-p.l-p.r),y=toY(point.value);index?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.strokeStyle='#2b6249';ctx.lineWidth=3;ctx.stroke();points.forEach((point,index)=>{if(index&&Math.abs(point.value-points[index-1].value)>settings.criticalThreshold){const x=p.l+point.turn/max*(w-p.l-p.r),y=toY(point.value);ctx.fillStyle='#b85d4b';ctx.beginPath();ctx.arc(x,y,6,0,Math.PI*2);ctx.fill()}})}
  const current=points.find(point=>point.turn===currentMove);if(current){const x=p.l+currentMove/max*(w-p.l-p.r),y=toY(current.value);ctx.fillStyle='#fff';ctx.strokeStyle='#244e3c';ctx.lineWidth=4;ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.fill();ctx.stroke()}
}

function renderAnalysis(){const result=currentAnalysis();if(!result){$('blackWin').textContent=$('whiteWin').textContent='--';$('evalBlack').innerHTML=$('evalWhite').innerHTML='--<sup>%</sup>';$('blackBar').style.width='0';$('leadLabel').textContent='等待分析';$('scoreLead').textContent='-- 目';$('visitsLabel').textContent='等待引擎';$('swingText').className='swing';$('swingText').textContent='当前手尚未分析';renderCandidates();return}const black=toBlackWin(result,result.rootInfo.winrate),white=100-black,lead=Number(result.rootInfo.scoreLead||0);$('blackWin').textContent=black.toFixed(1)+'%';$('whiteWin').textContent=white.toFixed(1)+'%';$('evalBlack').innerHTML=black.toFixed(1)+'<sup>%</sup>';$('evalWhite').innerHTML=white.toFixed(1)+'<sup>%</sup>';$('blackBar').style.width=black+'%';$('leadLabel').textContent=`${lead>=0?'黑棋':'白棋'}领先`;$('scoreLead').textContent=`${lead>=0?'+':''}${lead.toFixed(1)} 目`;$('visitsLabel').textContent=`访问 ${result.rootInfo.visits||0} 次`;const previous=analyses.get(currentMove-1);const delta=previous?black-toBlackWin(previous,previous.rootInfo.winrate):null;const swing=$('swingText');swing.className='swing '+(delta===null?'':delta<0?'down':'up');swing.textContent=delta===null?`KataGo · ${result.rootInfo.visits||0} 次访问`:`${delta<0?'↓':'↑'} 较上一手 ${delta>=0?'+':''}${delta.toFixed(1)}% · ${Math.abs(delta)>10?'关键手':'局面平稳'}`;renderCandidates()}
function update(){currentMove=Math.max(0,Math.min(currentMove,currentGame.moves.length));$('moveSlider').value=currentMove;$('moveNumber').textContent=currentMove;$('evalMove').textContent=currentMove;renderAnalysis();drawBoard();drawChart()}

function ensureAudio() {
  if (!settings.soundEnabled) return null;
  if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === 'suspended') audioContext.resume();
  return audioContext;
}
function playStoneSound(capture = false) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  const osc = ctx.createOscillator();
  osc.type = capture ? 'triangle' : 'sine';
  osc.frequency.setValueAtTime(capture ? 150 : 245, now);
  osc.frequency.exponentialRampToValueAtTime(capture ? 75 : 130, now + (capture ? .16 : .08));
  gain.gain.setValueAtTime(Math.max(.001, settings.volume * (capture ? .28 : .16)), now);
  gain.gain.exponentialRampToValueAtTime(.001, now + (capture ? .18 : .1));
  osc.connect(gain).connect(ctx.destination); osc.start(now); osc.stop(now + (capture ? .2 : .12));
  if (capture) {
    const click = ctx.createOscillator(); const clickGain = ctx.createGain();
    click.type = 'square'; click.frequency.value = 520; clickGain.gain.setValueAtTime(settings.volume * .08, now); clickGain.gain.exponentialRampToValueAtTime(.001, now + .05);
    click.connect(clickGain).connect(ctx.destination); click.start(now); click.stop(now + .06);
  }
}
function speakJudgement(result) {
  if (!settings.voiceEnabled || !window.speechSynthesis || !result || currentMove < 1 || lastSpokenMove === currentMove) return;
  const previous = analyses.get(currentMove - 1); if (!previous) return;
  const delta = toBlackWin(result, result.rootInfo.winrate) - toBlackWin(previous, previous.rootInfo.winrate);
  const mover = currentGame.moves[currentMove - 1]?.color;
  const swing = mover === 'W' ? -delta : delta;
  if (Math.abs(swing) < settings.criticalThreshold) return;
  const good = ['这手有说法！','好好好，这么玩是吧。','天才！'];
  const bad = ['坏了，这波亏麻了。','啊？这也能下？','完了，寄！'];
  const utterance = new SpeechSynthesisUtterance((swing > 0 ? good : bad)[currentMove % 3]);
  utterance.lang = 'zh-CN'; utterance.volume = Math.max(0, Math.min(1, settings.volume)); utterance.rate = 1.05;
  const voices = speechSynthesis.getVoices(); const zh = voices.find(v => /^zh/i.test(v.lang)); if (zh) utterance.voice = zh;
  speechSynthesis.cancel(); speechSynthesis.speak(utterance); lastSpokenMove = currentMove;
}

async function requestAnalysis(turns,maxVisits){const request={moves:currentGame.moves,initialStones:currentGame.setup||[],analyzeTurns:turns,maxVisits};if(window.__TAURI__?.core?.invoke)return window.__TAURI__.core.invoke('analyze_position',{request});const response=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});const body=await response.json();if(!response.ok)throw new Error(body.error||'KataGo 分析失败');return body.results}
async function analyzeCurrentPosition(){const token=++analysisRequest;$('engineStatus').className='status';$('engineStatus').innerHTML='<i></i>CUDA 分析中';$('swingText').textContent='正在等待本地 KataGo…';try{const results=await requestAnalysis([currentMove],settings.positionVisits);if(token!==analysisRequest)return;results.forEach(result=>analyses.set(result.turnNumber,result));$('engineStatus').innerHTML='<i></i>TensorRT / CUDA';renderAnalysis();drawBoard();drawChart();if(pendingJudgementMove===currentMove){speakJudgement(analyses.get(currentMove));pendingJudgementMove=null}}catch(error){if(token!==analysisRequest)return;$('engineStatus').className='status error';$('engineStatus').innerHTML='<i></i>引擎不可用';$('swingText').textContent=error.message;showToast(error.message)}}

function setMove(value){const next=Math.max(0,Math.min(Number(value),currentGame.moves.length));const forward=next===currentMove+1;if(forward){playStoneSound(capturedStones(currentGame.moves,next,19,currentGame.setup||[])>0)}currentMove=next;pendingJudgementMove=forward?next:null;update();if(forward&&analyses.has(currentMove)){speakJudgement(analyses.get(currentMove));pendingJudgementMove=null}clearTimeout(setMove.timer);setMove.timer=setTimeout(()=>{if(!analyses.has(currentMove))analyzeCurrentPosition()},180)}
function togglePlay(){if(playing){clearInterval(playing);playing=null;$('playButton').textContent='▶';return}if(currentMove>=currentGame.moves.length)currentMove=0;$('playButton').textContent='Ⅱ';playing=setInterval(()=>{if(currentMove>=currentGame.moves.length){togglePlay();return}setMove(currentMove+1)},Number($('speedSelect').value))}

$('searchInput').addEventListener('input',e=>renderGames(e.target.value));
$('importButton').onclick=()=>$('fileInput').click();
$('fileInput').onchange=async e=>{pendingImports=[];const fingerprints=new Set(games.map(game=>String(game.sgfText||'').replace(/\s+/g,'')));for(const file of e.target.files){try{const sgfText=await file.text(),fingerprint=sgfText.replace(/\s+/g,'');if(fingerprints.has(fingerprint)){showToast(file.name+': 棋谱已存在，已跳过');continue}fingerprints.add(fingerprint);const parsed=parseSgf(sgfText);pendingImports.push({...parsed,sgfText,title:parsed.title==='导入的棋谱'?file.name.replace(/\.sgf$/i,''):parsed.title,fileName:file.name,folder:'mine'});}catch(err){showToast(`${file.name}: ${err.message}`)}}if(pendingImports.length)openGameModal('import');e.target.value=''};
$('editGameButton').onclick=()=>openGameModal('edit');
$('exportButton').onclick=()=>{
  const esc=value=>String(value||'').replace(/\\/g,'\\\\').replace(/\]/g,'\\]').replace(/\[/g,'\\[').replace(/\r?\n/g,'\\n');
  const g=currentGame; const props=[['GM','1'],['FF','4'],['CA','UTF-8'],['GN',g.title],['PB',g.black],['PW',g.white],['BR',g.blackRank],['WR',g.whiteRank],['EV',g.event],['DT',g.date],['RE',g.result]].filter(([,v])=>v);
  const body=props.map(([k,v])=>`${k}[${esc(v)}]`).join('');
  const moves=g.moves.map(move=>move.pass?`;${move.color}[]`:`;${move.color}[${String.fromCharCode(97+move.x)}${String.fromCharCode(97+move.y)}]`).join('');
  const blob=new Blob([`(;${body}${moves})`],{type:'application/x-go-sgf'}); const url=URL.createObjectURL(blob); const link=document.createElement('a'); link.href=url; link.download=`${(g.title||'yijing-game').replace(/[\\/:*?"<>|]/g,'_')}.sgf`; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); showToast('SGF 已导出');
};
$('newFolderButton').onclick=()=>{$('folderNameInput').value='';$('folderModal').classList.remove('hidden');setTimeout(()=>$('folderNameInput').focus(),0)};
$('gameForm').onsubmit=e=>{e.preventDefault();const title=$('gameNameInput').value.trim(),folder=$('gameFolderSelect').value,tag=$('gameTagSelect').value;if(!title)return;if(modalMode==='import'){const parsed=pendingImports.shift();const game={...parsed,id:Date.now()+Math.random(),title,folder,tag,imported:true,favorite:false};delete game.fileName;games.unshift(game);saveLibrary();renderFolders();if(pendingImports.length){openGameModal('import');return}currentGame=game;activeFolder=folder;$('gameModal').classList.add('hidden');renderFolders();selectGame(game.id);showToast('棋谱已导入并保存分类')}else{currentGame.title=title;currentGame.folder=folder;currentGame.tag=tag;saveLibrary();activeFolder=currentGame.deleted?'trash':folder;$('gameModal').classList.add('hidden');renderFolders();renderGames();$('gameTitle').textContent=title;showToast('棋谱信息已保存')}};
$('folderForm').onsubmit=e=>{e.preventDefault();const name=$('folderNameInput').value.trim();if(!name)return;if(customFolders.some(folder=>folder.name===name)){showToast('已存在同名文件夹');return}const folder={id:`custom-${Date.now()}`,name};customFolders.push(folder);folderNames[folder.id]=name;saveLibrary();$('folderModal').classList.add('hidden');renderFolders();showToast(`已创建“${name}”`)};
$('tagForm').onsubmit=e=>{e.preventDefault();const name=$('tagNameInput').value.trim();if(!name)return;if(allTags().includes(name)){showToast('已存在同名标签');return}customTags.push(name);saveLibrary();$('tagModal').classList.add('hidden');renderTags();showToast(`已创建标签“${name}”`)};
$('newTagButton').onclick=()=>{$('tagNameInput').value='';$('tagModal').classList.remove('hidden');setTimeout(()=>$('tagNameInput').focus(),0)};
$('deleteGameButton').onclick=()=>{const restoring=currentGame.deleted;currentGame.deleted=!restoring;saveLibrary();$('gameModal').classList.add('hidden');renderFolders();const visible=renderGames();if(visible.length&&!visible.includes(currentGame))selectGame(visible[0].id);showToast(restoring?'棋谱已恢复':'棋谱已移到回收站')};
$('favoriteButton').onclick=()=>{currentGame.favorite=!currentGame.favorite;saveLibrary();$('favoriteButton').textContent=currentGame.favorite?'★':'☆';$('favoriteButton').classList.toggle('active',currentGame.favorite);renderGames($('searchInput').value);showToast(currentGame.favorite?'已收藏':'已取消收藏')};
$('filterButton').onclick=()=>{$('resultFilter').value=libraryFilter.result;$('favoriteFilter').checked=libraryFilter.favorites;$('filterModal').classList.remove('hidden')};
$('filterForm').onsubmit=e=>{e.preventDefault();libraryFilter={result:$('resultFilter').value,favorites:$('favoriteFilter').checked};$('filterModal').classList.add('hidden');$('filterButton').classList.toggle('active',Boolean(libraryFilter.result||libraryFilter.favorites));renderGames($('searchInput').value)};
$('resetFilterButton').onclick=()=>{libraryFilter={result:'',favorites:false};$('resultFilter').value='';$('favoriteFilter').checked=false;$('filterButton').classList.remove('active');renderGames($('searchInput').value);$('filterModal').classList.add('hidden')};
$('settingsButton').onclick=()=>{$('positionVisitsInput').value=settings.positionVisits;$('fullVisitsInput').value=settings.fullVisits;$('criticalThresholdInput').value=settings.criticalThreshold;$('soundEnabledInput').checked=settings.soundEnabled;$('voiceEnabledInput').checked=settings.voiceEnabled;$('volumeInput').value=settings.volume;$('settingsModal').classList.remove('hidden')};
$('settingsForm').onsubmit=e=>{e.preventDefault();settings={...settings,positionVisits:Number($('positionVisitsInput').value),fullVisits:Number($('fullVisitsInput').value),criticalThreshold:Number($('criticalThresholdInput').value),soundEnabled:$('soundEnabledInput').checked,voiceEnabled:$('voiceEnabledInput').checked,volume:Number($('volumeInput').value)};saveLibrary();$('soundButton').classList.toggle('active',settings.soundEnabled);$('soundButton').title=settings.soundEnabled?'关闭声音':'开启声音';$('settingsModal').classList.add('hidden');drawChart();showToast('分析设置已保存')};
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>closeModal(button.dataset.close));
document.querySelectorAll('.modal-backdrop').forEach(backdrop=>backdrop.onclick=e=>{if(e.target===backdrop)closeModal(backdrop.id)});
$('moveSlider').oninput=e=>setMove(e.target.value);$('firstButton').onclick=()=>setMove(0);$('prevButton').onclick=()=>setMove(currentMove-1);$('nextButton').onclick=()=>setMove(currentMove+1);$('lastButton').onclick=()=>setMove(currentGame.moves.length);$('playButton').onclick=togglePlay;
$('speedSelect').onchange=()=>{if(playing){togglePlay();togglePlay()}};
$('numberToggle').onclick=e=>{showNumbers=!showNumbers;e.currentTarget.classList.toggle('active',showNumbers);drawBoard()};$('heatToggle').onclick=e=>{showHeat=!showHeat;e.currentTarget.classList.toggle('active',showHeat);drawBoard()};$('markButton').onclick=e=>{marking=!marking;e.currentTarget.classList.toggle('active',marking);showToast(marking?'请选择棋盘交叉点':'已退出标记模式')};
$('soundButton').onclick=e=>{settings.soundEnabled=!settings.soundEnabled;e.currentTarget.classList.toggle('active',settings.soundEnabled);e.currentTarget.title=settings.soundEnabled?'关闭声音':'开启声音';saveLibrary();if(settings.soundEnabled)playStoneSound(false)};
boardCanvas.onclick=e=>{if(!marking)return;const rect=boardCanvas.getBoundingClientRect(),scale=boardCanvas.width/rect.width,step=(boardCanvas.width-86)/18;const x=Math.round((e.offsetX*scale-43)/step),y=Math.round((e.offsetY*scale-43)/step);if(x>=0&&x<19&&y>=0&&y<19){mark={x,y};marking=false;$('markButton').classList.remove('active');drawBoard();showToast(`已标记 ${pointName(x,y)}`)}};
$('listViewButton').onclick=()=>{listMode='list';$('listViewButton').classList.add('active');$('gridViewButton').classList.remove('active');renderGames($('searchInput').value)};
$('gridViewButton').onclick=()=>{listMode='grid';$('gridViewButton').classList.add('active');$('listViewButton').classList.remove('active');renderGames($('searchInput').value)};
document.querySelectorAll('.chart-tabs button').forEach(button=>button.onclick=()=>{chartMode=button.dataset.chart;document.querySelectorAll('.chart-tabs button').forEach(item=>item.classList.toggle('active',item===button));$('chartTitle').textContent=chartMode==='winrate'?'胜率走势':'目差走势';$('chartLegend').innerHTML=`<i class="legend-black"></i>${chartMode==='winrate'?'黑棋胜率':'黑棋目差'}`;drawChart()});
$('analyzeButton').onclick=async()=>{const button=$('analyzeButton'),progress=$('analysisProgress');button.disabled=true;$('analysisLabel').textContent='CUDA 正在分析整局…';$('analysisMeta').textContent='请稍候';progress.className='loading';try{const turns=Array.from({length:currentGame.moves.length+1},(_,i)=>i),results=await requestAnalysis(turns,settings.fullVisits);results.forEach(result=>analyses.set(result.turnNumber,result));$('analysisLabel').textContent='全局分析已完成';$('analysisMeta').textContent=`${results.length} / ${turns.length} 手`;button.textContent='重新分析';update();showToast('KataGo 整局分析完成')}catch(error){$('analysisLabel').textContent='分析失败';$('analysisMeta').textContent=error.message;showToast(error.message)}finally{button.disabled=false;progress.className='';progress.style.width=analyses.size?`${analyses.size/(currentGame.moves.length+1)*100}%`:'0';saveLibrary()}};
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('searchInput').focus();$('searchInput').select();return}if(e.key==='Escape'&&marking){marking=false;$('markButton').classList.remove('active');showToast('已退出标记模式');return}if(e.target.matches('input,textarea'))return;if(e.key==='ArrowLeft')setMove(currentMove-1);if(e.key==='ArrowRight')setMove(currentMove+1);if(e.key===' ') {e.preventDefault();togglePlay()}});

renderFolders();renderTags();renderGames();update();analyzeCurrentPosition();

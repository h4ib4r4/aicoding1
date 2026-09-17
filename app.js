const { replay, capturedStones, parseSgf, pointName, gtpPointToCoords, groupCounts, groupTaxAdjustment, moveNumberAt, CANDIDATE_MARKS, resolveRules } = window.YijingCore;

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
const savedGames = loadLocal('yijing.games', []);
const collection = window.YijingCollection || [];
const needsCollection = collection.length > 0 && !loadLocal('yijing.collection.danghu.v1', false);
const libraryGames = needsCollection ? savedGames.filter(game => !demoGames.some(demo => demo.id === game.id && demo.black === game.black && demo.white === game.white && !game.sgfText && !game.imported)) : savedGames;
if (needsCollection) {
  localStorage.setItem('yijing.backup.before-danghu', JSON.stringify(savedGames));
  for (const game of collection) if (!libraryGames.some(existing => existing.id === game.id || existing.sgfText === game.sgfText)) libraryGames.push(game);
}
// 老版本存下来的棋谱没有规则元数据，按 id/原文从内置数据回填，否则古谱会被当成现代规则评估
function backfillRuleset(list) {
  let changed = false;
  for (const game of list) {
    if (game.ruleset) continue;
    const source = collection.find(entry => entry.id === game.id || (entry.sgfText && entry.sgfText === game.sgfText));
    if (source?.ruleset) { game.ruleset = source.ruleset; changed = true; }
  }
  return changed;
}
const rulesetBackfilled = backfillRuleset(libraryGames);
const games = libraryGames.map(game => {
  if (game.sgfText) {
    try {
      const parsed = parseSgf(game.sgfText);
      return { ...game, ...parsed, title: game.title, folder: game.folder, tag: game.tag, favorite: game.favorite, deleted: game.deleted,
        ruleset: game.ruleset || parsed.ruleset || '', komi: game.komi === undefined || game.komi === null ? parsed.komi : game.komi };
    } catch {}
  }
  return { ...game, ruleset: game.ruleset || '', moves: (game.moves || []).map(move => !move.pass && (move.x < 0 || move.y < 0 || move.x >= 19 || move.y >= 19) ? { color: move.color, pass: true } : move) };
});
const customFolders = loadLocal('yijing.folders', []);
if (needsCollection && !customFolders.some(folder => folder.id === 'classic-danghu')) customFolders.push({id:'classic-danghu',name:'古谱 · 当湖十局'});
const customTags = loadLocal('yijing.tags', []);

let currentGame = games[0];
let currentMove = 38;
let playing = null;
let mark = null;
let marking = false;
let analyses = new Map();
let analysisRequest = 0;
let activeFolder = 'all';
let chartMode = 'winrate';
let listMode = 'list';
let libraryFilter = { result: '', favorites: false };
let settings = { positionVisits: 64, fullVisits: 24, criticalThreshold: 10, soundEnabled: true, voiceEnabled: true, volume: 0.55, showNumbers: true, showHeat: true, ...loadLocal('yijing.settings', {}) };
// 手数与 AI 候选点是显示项，状态存进 settings 一起落盘，重开浏览器保持不变
let showNumbers = settings.showNumbers !== false;
let showHeat = settings.showHeat !== false;
let audioContext = null;
let audioMasterGain = null;
let noiseBuffer = null;
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

// 还棋头是终局结算规则，只在棋谱记录的终局位置上算一次，不混进逐手曲线
const taxCache = new Map();
function gameGroupTax(game) {
  if (!game || !resolveRules(game).groupTax || !Array.isArray(game.moves) || !game.moves.length) return null;
  if (!taxCache.has(game.id)) {
    const board = replay(game.moves, game.moves.length, 19, game.setup || []);
    taxCache.set(game.id, { counts: groupCounts(board), adjustment: groupTaxAdjustment(board) });
  }
  return taxCache.get(game.id);
}

function renderRules() {
  const rules = resolveRules(currentGame);
  const historical = rules.id !== 'modern';
  const chip = $('ruleChip');
  chip.textContent = rules.name;
  chip.title = rules.note;
  chip.classList.toggle('hidden', !historical);
  $('chartRuleNote').textContent = historical ? `· ${rules.name} · 贴 ${rules.komi} 目 · 不含还棋头` : '';
  const note = $('taxNote');
  const tax = gameGroupTax(currentGame);
  if (!tax) { note.classList.add('hidden'); note.textContent = ''; return; }
  note.classList.remove('hidden');
  note.textContent = `终局还棋头 黑 ${tax.adjustment >= 0 ? '+' : ''}${tax.adjustment} 目 · 黑 ${tax.counts.B} 块 / 白 ${tax.counts.W} 块`;
}

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
  document.querySelectorAll('.game-card').forEach(card => card.onclick = () => { selectGame(Number(card.dataset.id)); closeOverlayLayers(); });
  $('gameList').classList.toggle('grid',listMode==='grid');
  return visible;
}

function selectGame(id) {
  currentGame = games.find(g => g.id === id) || games[0]; currentMove = Math.min(38,currentGame.moves.length); mark = null; marking = false; $('markButton').classList.remove('active'); analyses = new Map(); pendingJudgementMove = null; lastSpokenMove = null;
  $('gameTitle').textContent=currentGame.title; $('blackName').innerHTML=`${currentGame.black} <small>${currentGame.blackRank}</small>`; $('whiteName').innerHTML=`${currentGame.white} <small>${currentGame.whiteRank}</small>`;
  const gameMeta=[currentGame.event,currentGame.date,currentGame.result].filter(Boolean).join(' · ');
  $('gameMeta').textContent=gameMeta;
  const metaSep=document.querySelector('.title-block .sep'); if(metaSep)metaSep.style.display=gameMeta?'':'none';
  $('favoriteButton').textContent=currentGame.favorite?'★':'☆';$('favoriteButton').classList.toggle('active',Boolean(currentGame.favorite));
  $('moveSlider').max=currentGame.moves.length; $('moveTotal').textContent=currentGame.moves.length;
  renderRules();
  renderGames($('searchInput').value); update(); analyzeCurrentPosition();
}

function boardMetrics(){
  const size=Math.max(160,gobanEl.clientWidth||760);
  const pad=size*0.0555;
  return {size,pad,step:(size-pad*2)/18};
}

function drawBoard(){
  const {size,pad,step}=boardMetrics();
  const ctx=boardCtx,dpr=window.devicePixelRatio||1,px=Math.round(size*dpr);
  if(boardCanvas.width!==px||boardCanvas.height!==px){boardCanvas.width=px;boardCanvas.height=px}
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,size,size);
  const k=size/760;

  const gradient=ctx.createLinearGradient(0,0,size,size);
  gradient.addColorStop(0,'#e9c98f');gradient.addColorStop(.52,'#d8ae6c');gradient.addColorStop(1,'#c99c59');
  ctx.fillStyle=gradient;ctx.fillRect(0,0,size,size);
  const sheen=ctx.createRadialGradient(size*.32,size*.15,size*.02,size*.5,size*.5,size*.95);
  sheen.addColorStop(0,'rgba(255,247,226,.3)');sheen.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle=sheen;ctx.fillRect(0,0,size,size);

  ctx.strokeStyle='rgba(64,44,21,.7)';ctx.lineWidth=Math.max(1,1.15*k);
  for(let i=0;i<19;i++){
    const n=pad+i*step;
    ctx.beginPath();ctx.moveTo(pad,n);ctx.lineTo(size-pad,n);ctx.stroke();
    ctx.beginPath();ctx.moveTo(n,pad);ctx.lineTo(n,size-pad);ctx.stroke();
  }
  ctx.fillStyle='#4f371f';
  [3,9,15].forEach(x=>[3,9,15].forEach(y=>{ctx.beginPath();ctx.arc(pad+x*step,pad+y*step,4.6*k,0,Math.PI*2);ctx.fill()}));

  // 木边上的坐标，按围棋惯例跳过 I
  const letters='ABCDEFGHJKLMNOPQRST';
  ctx.fillStyle='rgba(92,62,30,.6)';
  ctx.font=`${Math.max(8,Math.round(step*.3))}px "Microsoft YaHei UI","PingFang SC",sans-serif`;
  ctx.textAlign='center';ctx.textBaseline='middle';
  for(let i=0;i<19;i++){
    const n=pad+i*step;
    ctx.fillText(letters[i],n,pad*.5);
    ctx.fillText(letters[i],n,size-pad*.5);
    ctx.fillText(String(19-i),pad*.5,n);
    ctx.fillText(String(19-i),size-pad*.5,n);
  }

  const board=replay(currentGame.moves,currentMove,19,currentGame.setup||[]);
  const radius=step*.45;
  // 同一交叉点被反复争夺时取最后一次落子，与「第 N 手落在哪里」一致
  const numbers=moveNumberAt(currentGame.moves,currentMove);
  const lastMove=currentMove?currentGame.moves[currentMove-1]:null;
  const lastKey=lastMove&&!lastMove.pass?`${lastMove.x},${lastMove.y}`:'';

  board.forEach((row,y)=>row.forEach((color,x)=>{
    if(!color)return;
    const cx=pad+x*step,cy=pad+y*step;
    const g=ctx.createRadialGradient(cx-radius*.35,cy-radius*.42,radius*.06,cx,cy,radius);
    if(color==='B'){g.addColorStop(0,'#5d635e');g.addColorStop(.55,'#242a26');g.addColorStop(1,'#0a0d0b')}
    else{g.addColorStop(0,'#fff');g.addColorStop(.68,'#f2f1ec');g.addColorStop(1,'#cac8c0')}
    ctx.fillStyle=g;
    ctx.shadowColor='rgba(76,50,31,.42)';ctx.shadowBlur=4.2*k;ctx.shadowOffsetY=2.2*k;
    ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.fill();
    ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetY=0;
  }));

  // 手数用数字；当前这一手换成强调色，跟其余手数拉开层次
  ctx.font=`600 ${Math.max(8,Math.round(step*.36))}px "Microsoft YaHei UI","PingFang SC",sans-serif`;
  ctx.textAlign='center';ctx.textBaseline='middle';
  board.forEach((row,y)=>row.forEach((color,x)=>{
    if(!color)return;
    const index=numbers.get(`${x},${y}`);
    if(!index)return;
    const isLast=`${x},${y}`===lastKey;
    if(!showNumbers&&!isLast)return;
    const cx=pad+x*step,cy=pad+y*step;
    ctx.fillStyle=isLast?(color==='B'?'#ffab84':'#c03f28'):(color==='B'?'#ececec':'#333333');
    ctx.fillText(index,cx,cy);
  }));

  // 实际着棋点：棋子外圈的高亮环，关掉手数也一眼能认出来
  if(lastMove&&!lastMove.pass){
    const cx=pad+lastMove.x*step,cy=pad+lastMove.y*step;
    ctx.beginPath();ctx.arc(cx,cy,radius*1.18,0,Math.PI*2);
    ctx.strokeStyle='rgba(214,79,52,.28)';ctx.lineWidth=Math.max(4,6.4*k);ctx.stroke();
    ctx.beginPath();ctx.arc(cx,cy,radius*1.18,0,Math.PI*2);
    ctx.strokeStyle='#d64f34';ctx.lineWidth=Math.max(1.6,2.3*k);ctx.stroke();
  }

  // AI 候选点改用字母，画成空心圈 + 白描边：形状、字形都跟棋子/手数分得开
  if(showHeat&&currentMove<currentGame.moves.length){
    const palette=['#1f7a52','#a9741a','#a04a35'];
    const labelFont=`700 ${Math.max(9,Math.round(step*.33))}px "Microsoft YaHei UI","PingFang SC",sans-serif`;
    candidates().forEach((c,i)=>{
      const cx=pad+c.x*step,cy=pad+c.y*step;
      const color=palette[i]||palette[palette.length-1];
      const mark=CANDIDATE_MARKS[i]||String(i+1);
      ctx.strokeStyle=color;ctx.lineWidth=Math.max(1.3,(i?1.7:2.4)*k);
      ctx.beginPath();ctx.arc(cx,cy,step*.27,0,Math.PI*2);ctx.stroke();
      ctx.font=labelFont;ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.lineWidth=Math.max(2.4,3.4*k);ctx.strokeStyle='rgba(255,252,246,.92)';
      ctx.strokeText(mark,cx,cy);
      ctx.fillStyle=color;ctx.fillText(mark,cx,cy);
    });
  }
  if(mark){
    ctx.strokeStyle='#c34e3f';ctx.lineWidth=Math.max(2.4,4*k);
    ctx.beginPath();
    ctx.moveTo(pad+mark.x*step,pad+(mark.y-.3)*step);
    ctx.lineTo(pad+(mark.x-.3)*step,pad+(mark.y+.26)*step);
    ctx.lineTo(pad+(mark.x+.3)*step,pad+(mark.y+.26)*step);
    ctx.closePath();ctx.stroke();
  }
}

function boardCoordsFromEvent(event){
  const rect=boardCanvas.getBoundingClientRect(),{pad,step}=boardMetrics();
  return {x:Math.round((event.clientX-rect.left-pad)/step),y:Math.round((event.clientY-rect.top-pad)/step)};
}

function currentAnalysis(){return analyses.get(currentMove)}
function candidates(){return (currentAnalysis()?.moveInfos||[]).slice(0,3).map(info=>({...gtpPointToCoords(info.move),...info})).filter(move=>Number.isInteger(move.x)&&Number.isInteger(move.y))}

function toBlackWin(_result, rate){return rate*100}
function renderCandidates(){const result=currentAnalysis();const moves=candidates();$('candidateList').innerHTML=moves.length?moves.map((c,i)=>`<div class="candidate ${i===0?'active':''}" data-x="${c.x}" data-y="${c.y}"><span class="candidate-index">${CANDIDATE_MARKS[i]||i+1}</span><div class="candidate-main"><b>${c.move}</b><span>${i?'候选变化':'KataGo 首选'} · ${c.visits||0} 次访问</span></div><div class="candidate-win"><b>${toBlackWin(result,c.winrate).toFixed(1)}%</b><span>${Number(c.scoreLead||0)>=0?'+':''}${Number(c.scoreLead||0).toFixed(1)} 目</span></div></div>`).join(''):'<div class="empty-analysis">分析后显示推荐着法</div>';document.querySelectorAll('.candidate').forEach(el=>el.onclick=()=>{mark={x:+el.dataset.x,y:+el.dataset.y};drawBoard();showToast(`已在棋盘标出候选点 ${pointName(mark.x,mark.y)}`)})}

function resizeChartCanvas(){const rect=chartCanvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1,width=Math.max(1,Math.round(rect.width)),height=Math.max(1,Math.round(rect.height));const pixelWidth=Math.round(width*dpr),pixelHeight=Math.round(height*dpr);if(chartCanvas.width!==pixelWidth||chartCanvas.height!==pixelHeight){chartCanvas.width=pixelWidth;chartCanvas.height=pixelHeight}chartCtx.setTransform(dpr,0,0,dpr,0,0);return {width,height}}

function drawChart(){
  if(!layers.timeline.open){chartCtx.setTransform(1,0,0,1,0,0);chartCtx.clearRect(0,0,chartCanvas.width,chartCanvas.height);return}
  const ctx=chartCtx,{width:w,height:h}=resizeChartCanvas();
  if(w<60||h<26)return;
  const expanded=timelineEl.classList.contains('expanded');
  const pad={l:expanded?40:10,r:expanded?18:8,t:expanded?14:8,b:expanded?22:8};
  const winrate=chartMode==='winrate';
  const total=Math.max(1,currentGame.moves.length);
  ctx.clearRect(0,0,w,h);
  ctx.font='10px "Microsoft YaHei UI","PingFang SC",sans-serif';ctx.textBaseline='middle';

  const ticks=winrate?[0,25,50,75,100]:[-20,-10,0,10,20];
  const toY=value=>winrate?pad.t+(100-value)/100*(h-pad.t-pad.b):pad.t+(20-Math.max(-20,Math.min(20,value)))/40*(h-pad.t-pad.b);
  const toX=turn=>pad.l+turn/total*(w-pad.l-pad.r);
  ctx.strokeStyle='rgba(74,84,76,.14)';ctx.lineWidth=1;
  ticks.forEach(value=>{
    const y=Math.round(toY(value))+.5;
    ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();
    if(expanded&&(winrate?value%25===0:true)){ctx.fillStyle='#a4aba5';ctx.textAlign='right';ctx.fillText(`${value}${winrate?'%':''}`,pad.l-8,y)}
  });

  const points=[...analyses.values()]
    .map(result=>({turn:result.turnNumber,value:winrate?toBlackWin(result,result.rootInfo.winrate):Number(result.rootInfo.scoreLead||0)}))
    .filter(point=>point.turn>=0&&point.turn<=total).sort((a,b)=>a.turn-b.turn);
  if(!points.length){
    if(expanded){ctx.fillStyle='#a8afa9';ctx.textAlign='center';ctx.fillText('跑一次「分析整局」，这里会出现每一手的走势曲线',w/2,h/2)}
    return;
  }

  const cursorX=toX(currentMove);
  ctx.strokeStyle='rgba(35,76,58,.2)';ctx.lineWidth=1;ctx.setLineDash([3,3]);
  ctx.beginPath();ctx.moveTo(cursorX,pad.t);ctx.lineTo(cursorX,h-pad.b);ctx.stroke();ctx.setLineDash([]);

  const base=winrate?toY(50):toY(0);
  ctx.beginPath();
  points.forEach((point,index)=>{const x=toX(point.turn),y=toY(point.value);index?ctx.lineTo(x,y):ctx.moveTo(x,y)});
  ctx.lineTo(toX(points[points.length-1].turn),base);ctx.lineTo(toX(points[0].turn),base);ctx.closePath();
  const fill=ctx.createLinearGradient(0,pad.t,0,h-pad.b);
  fill.addColorStop(0,'rgba(45,101,74,.24)');fill.addColorStop(1,'rgba(45,101,74,.02)');
  ctx.fillStyle=fill;ctx.fill();

  ctx.beginPath();
  points.forEach((point,index)=>{const x=toX(point.turn),y=toY(point.value);index?ctx.lineTo(x,y):ctx.moveTo(x,y)});
  ctx.strokeStyle='#2b6249';ctx.lineWidth=2;ctx.lineJoin='round';ctx.lineCap='round';ctx.stroke();

  points.forEach((point,index)=>{
    const x=toX(point.turn),y=toY(point.value);
    if(index&&Math.abs(point.value-points[index-1].value)>settings.criticalThreshold){
      ctx.fillStyle='#b4553f';ctx.beginPath();ctx.arc(x,y,expanded?4.4:3.2,0,Math.PI*2);ctx.fill();
    }else if(expanded&&point.turn!==currentMove){
      ctx.fillStyle='rgba(43,98,73,.5)';ctx.beginPath();ctx.arc(x,y,2,0,Math.PI*2);ctx.fill();
    }
  });

  const current=points.find(point=>point.turn===currentMove);
  if(current){
    ctx.fillStyle='#fff';ctx.strokeStyle='#244e3c';ctx.lineWidth=2.5;
    ctx.beginPath();ctx.arc(cursorX,toY(current.value),expanded?5.5:4,0,Math.PI*2);ctx.fill();ctx.stroke();
  }
  if(expanded){
    ctx.fillStyle='#a4aba5';ctx.textAlign='center';
    [0,.25,.5,.75,1].forEach(ratio=>ctx.fillText(String(Math.round(total*ratio)),toX(total*ratio),h-pad.b/2));
  }
}

function renderAnalysis(){const result=currentAnalysis();if(!result){$('blackWin').textContent=$('whiteWin').textContent='--';$('evalBlack').innerHTML=$('evalWhite').innerHTML='--<sup>%</sup>';$('blackBar').style.width='0';$('leadLabel').textContent='等待分析';$('scoreLead').textContent='-- 目';$('visitsLabel').textContent='等待引擎';$('swingText').className='swing';$('swingText').textContent='当前手尚未分析';renderCandidates();return}const black=toBlackWin(result,result.rootInfo.winrate),white=100-black,lead=Number(result.rootInfo.scoreLead||0);$('blackWin').textContent=black.toFixed(1)+'%';$('whiteWin').textContent=white.toFixed(1)+'%';$('evalBlack').innerHTML=black.toFixed(1)+'<sup>%</sup>';$('evalWhite').innerHTML=white.toFixed(1)+'<sup>%</sup>';$('blackBar').style.width=black+'%';$('leadLabel').textContent=`${lead>=0?'黑棋':'白棋'}领先`;$('scoreLead').textContent=`${lead>=0?'+':''}${lead.toFixed(1)} 目`;$('visitsLabel').textContent=`访问 ${result.rootInfo.visits||0} 次`;const previous=analyses.get(currentMove-1);const delta=previous?black-toBlackWin(previous,previous.rootInfo.winrate):null;const swing=$('swingText');swing.className='swing '+(delta===null?'':delta<0?'down':'up');swing.textContent=delta===null?`KataGo · ${result.rootInfo.visits||0} 次访问`:`${delta<0?'↓':'↑'} 较上一手 ${delta>=0?'+':''}${delta.toFixed(1)}% · ${Math.abs(delta)>10?'关键手':'局面平稳'}`;renderCandidates()}
function update(){currentMove=Math.max(0,Math.min(currentMove,currentGame.moves.length));$('moveSlider').value=currentMove;$('moveNumber').textContent=currentMove;$('evalMove').textContent=currentMove;renderAnalysis();drawBoard();drawChart()}

/* ── 音效：云子磕在木盘上的清脆声，用「噪声瞬态 + 木腔谐振 + 低频托底」合成 ──
   纯振荡器听起来像电子提示音；清脆感来自极短的宽带瞬态，木质厚度来自中频谐振，
   再把每次的音高与衰减做小幅随机，连续落子才不会像复读。 */
function ensureAudio() {
  if (!settings.soundEnabled) return null;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  if (!audioContext || audioContext.state === 'closed') { audioContext = new AudioCtor(); audioMasterGain = null; }
  if (audioContext.state === 'suspended') { const resumed = audioContext.resume(); if (resumed?.catch) resumed.catch(() => {}); }
  return audioContext;
}
function audioBus(ctx) {
  if (!audioMasterGain || audioMasterGain.context !== ctx) {
    audioMasterGain = ctx.createGain();
    audioMasterGain.gain.value = 1;
    audioMasterGain.connect(ctx.destination);
  }
  audioMasterGain.gain.setTargetAtTime(Math.max(.0001, Math.min(1, Number(settings.volume) || 0)), ctx.currentTime, .01);
  return audioMasterGain;
}
// 白噪声只生成一次，反复复用
function whiteNoise(ctx) {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ctx.sampleRate) {
    const length = Math.max(1, Math.round(ctx.sampleRate * .2));
    noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}
// 一段带限噪声：起振 1ms、指数衰减，越短越清脆
function noiseClick(ctx, bus, at, { freq, q, dur, gain, type = 'bandpass' }) {
  const source = ctx.createBufferSource();
  source.buffer = whiteNoise(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
  const env = ctx.createGain();
  env.gain.setValueAtTime(.0001, at);
  env.gain.exponentialRampToValueAtTime(Math.max(.0002, gain), at + .0012);
  env.gain.exponentialRampToValueAtTime(.0001, at + dur);
  source.connect(filter); filter.connect(env); env.connect(bus);
  source.start(at); source.stop(at + dur + .03);
}
// 木盘被敲到的低频托底
function woodThump(ctx, bus, at, { freq, dur, gain }) {
  const osc = ctx.createOscillator(), env = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, at);
  osc.frequency.exponentialRampToValueAtTime(Math.max(50, freq * .62), at + dur);
  env.gain.setValueAtTime(.0001, at);
  env.gain.exponentialRampToValueAtTime(Math.max(.0002, gain), at + .004);
  env.gain.exponentialRampToValueAtTime(.0001, at + dur);
  osc.connect(env); env.connect(bus);
  osc.start(at); osc.stop(at + dur + .03);
}
// 一颗子：高频瞬态（脆）+ 中频木腔（厚）+ 低频托底（沉）
function stoneHit(ctx, bus, at, gain = 1, spread = 1) {
  const pitch = 1 + (Math.random() - .5) * .18 * spread;
  noiseClick(ctx, bus, at, { freq: 5200 * pitch, q: 1.2, dur: .018, gain: .26 * gain, type: 'highpass' });
  noiseClick(ctx, bus, at, { freq: 2500 * pitch, q: 9, dur: .05, gain: .3 * gain });
  noiseClick(ctx, bus, at + .002, { freq: 880 * pitch, q: 3.2, dur: .085, gain: .15 * gain });
  woodThump(ctx, bus, at, { freq: 205 * pitch, dur: .1, gain: .1 * gain });
}
function playStoneSound(capture = false) {
  const ctx = ensureAudio();
  if (!ctx) return;
  const bus = audioBus(ctx);
  const now = ctx.currentTime + .012;
  if (!capture) { stoneHit(ctx, bus, now); return; }
  // 提子：几颗子被依次拎起、相互轻碰，收尾一声闷响
  const count = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    stoneHit(ctx, bus, now + i * (.017 + Math.random() * .013), Math.max(.35, 1 - i * .16), 2.4);
  }
  woodThump(ctx, bus, now + count * .02, { freq: 150, dur: .17, gain: .13 });
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

async function requestAnalysis(turns,maxVisits){const rules=resolveRules(currentGame);const request={moves:currentGame.moves,initialStones:currentGame.setup||[],analyzeTurns:turns,maxVisits,rules:rules.rules,komi:rules.komi};if(window.__TAURI__?.core?.invoke)return window.__TAURI__.core.invoke('analyze_position',{request});const response=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});const body=await response.json();if(!response.ok)throw new Error(body.error||'KataGo 分析失败');return body.results}
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
$('settingsButton').onclick=()=>{$('positionVisitsInput').value=settings.positionVisits;$('fullVisitsInput').value=settings.fullVisits;$('criticalThresholdInput').value=settings.criticalThreshold;$('soundEnabledInput').checked=settings.soundEnabled;$('voiceEnabledInput').checked=settings.voiceEnabled;$('volumeInput').value=settings.volume;$('showNumbersInput').checked=showNumbers;$('showHeatInput').checked=showHeat;$('settingsModal').classList.remove('hidden')};
$('settingsForm').onsubmit=e=>{e.preventDefault();settings={...settings,positionVisits:Number($('positionVisitsInput').value),fullVisits:Number($('fullVisitsInput').value),criticalThreshold:Number($('criticalThresholdInput').value),soundEnabled:$('soundEnabledInput').checked,voiceEnabled:$('voiceEnabledInput').checked,volume:Number($('volumeInput').value)};saveLibrary();setShowNumbers($('showNumbersInput').checked,false);setShowHeat($('showHeatInput').checked,false);$('soundButton').classList.toggle('active',settings.soundEnabled);$('soundButton').title=settings.soundEnabled?'关闭声音':'开启声音';$('settingsModal').classList.add('hidden');drawChart();showToast('分析设置已保存')};
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>closeModal(button.dataset.close));
document.querySelectorAll('.modal-backdrop').forEach(backdrop=>backdrop.onclick=e=>{if(e.target===backdrop)closeModal(backdrop.id)});
$('moveSlider').oninput=e=>setMove(e.target.value);$('firstButton').onclick=()=>setMove(0);$('prevButton').onclick=()=>setMove(currentMove-1);$('nextButton').onclick=()=>setMove(currentMove+1);$('lastButton').onclick=()=>setMove(currentGame.moves.length);$('playButton').onclick=togglePlay;
$('speedSelect').onchange=()=>{if(playing){togglePlay();togglePlay()}};
// 手数 / AI 候选点是显示项：状态写进 settings，dock 按钮、设置弹窗与棋盘三处同步
function setShowNumbers(value,announce){showNumbers=value;settings.showNumbers=value;$('numberToggle').classList.toggle('active',value);$('numberToggle').title=`${value?'隐藏':'显示'}手数（N）`;const box=$('showNumbersInput');if(box)box.checked=value;saveLibrary();drawBoard();if(announce)showToast(value?'手数已显示（数字）':'手数已隐藏，仅保留当前手')}
function setShowHeat(value,announce){showHeat=value;settings.showHeat=value;$('heatToggle').classList.toggle('active',value);$('heatToggle').title=`${value?'隐藏':'显示'} AI 候选点（H）`;const box=$('showHeatInput');if(box)box.checked=value;saveLibrary();drawBoard();if(announce)showToast(value?'AI 候选点已显示：字母 A / B / C':'AI 候选点已隐藏')}
$('numberToggle').onclick=()=>setShowNumbers(!showNumbers,true);
$('heatToggle').onclick=()=>setShowHeat(!showHeat,true);
$('markButton').onclick=e=>{marking=!marking;e.currentTarget.classList.toggle('active',marking);showToast(marking?'请点棋盘交叉点标记（M 或 Esc 退出）':'已退出标记模式')};
$('soundButton').onclick=e=>{settings.soundEnabled=!settings.soundEnabled;e.currentTarget.classList.toggle('active',settings.soundEnabled);e.currentTarget.title=settings.soundEnabled?'关闭声音':'开启声音';saveLibrary();if(settings.soundEnabled)playStoneSound(false)};
boardCanvas.onclick=e=>{if(!marking)return;const {x,y}=boardCoordsFromEvent(e);if(x>=0&&x<19&&y>=0&&y<19){mark={x,y};marking=false;$('markButton').classList.remove('active');drawBoard();showToast(`已标记 ${pointName(x,y)}`)}};
$('listViewButton').onclick=()=>{listMode='list';$('listViewButton').classList.add('active');$('gridViewButton').classList.remove('active');renderGames($('searchInput').value)};
$('gridViewButton').onclick=()=>{listMode='grid';$('gridViewButton').classList.add('active');$('listViewButton').classList.remove('active');renderGames($('searchInput').value)};
document.querySelectorAll('.chart-tabs button').forEach(button=>button.onclick=()=>{chartMode=button.dataset.chart;document.querySelectorAll('.chart-tabs button').forEach(item=>item.classList.toggle('active',item===button));$('chartTitle').textContent=chartMode==='winrate'?'胜率走势':'目差走势';$('chartLegend').innerHTML=`<i class="legend-black"></i>${chartMode==='winrate'?'黑棋胜率':'黑棋目差'}`;drawChart()});
$('analyzeButton').onclick=async()=>{const button=$('analyzeButton'),progress=$('analysisProgress');button.disabled=true;$('analysisLabel').textContent='CUDA 正在分析整局…';$('analysisMeta').textContent='请稍候';progress.className='loading';try{const turns=Array.from({length:currentGame.moves.length+1},(_,i)=>i),results=await requestAnalysis(turns,settings.fullVisits);results.forEach(result=>analyses.set(result.turnNumber,result));$('analysisLabel').textContent='全局分析已完成';$('analysisMeta').textContent=`${results.length} / ${turns.length} 手`;button.textContent='重新分析';update();showToast('KataGo 整局分析完成')}catch(error){$('analysisLabel').textContent='分析失败';$('analysisMeta').textContent=error.message;showToast(error.message)}finally{button.disabled=false;progress.className='';progress.style.width=analyses.size?`${analyses.size/(currentGame.moves.length+1)*100}%`:'0';saveLibrary()}};
document.addEventListener('keydown',e=>{
  const typing=e.target.matches('input,textarea,select')||e.target.isContentEditable;
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();setLayer('library',true);$('searchInput').focus();$('searchInput').select();return}
  if(e.key==='Escape'){
    const openModal=document.querySelector('.modal-backdrop:not(.hidden)');
    if(openModal){closeModal(openModal.id);return}
    if(marking){marking=false;$('markButton').classList.remove('active');showToast('已退出标记模式');return}
    if(layerOpen()){closeTopLayer();return}
    if(document.body.classList.contains('focus'))setFocus(false);
    return;
  }
  if(typing||e.metaKey||e.ctrlKey||e.altKey)return;
  const key=e.key.toLowerCase();
  if(key==='l'){e.preventDefault();toggleLayer('library')}
  else if(key==='a'){e.preventDefault();toggleLayer('analysis')}
  else if(key==='t'){e.preventDefault();toggleLayer('timeline')}
  else if(key==='f'){e.preventDefault();setFocus(!document.body.classList.contains('focus'))}
  else if(key==='n'){e.preventDefault();setShowNumbers(!showNumbers,true)}
  else if(key==='h'){e.preventDefault();setShowHeat(!showHeat,true)}
  else if(key==='m'){e.preventDefault();$('markButton').click()}
  else if(e.key==='ArrowLeft')setMove(currentMove-1);
  else if(e.key==='ArrowRight')setMove(currentMove+1);
  else if(e.key===' '){e.preventDefault();togglePlay()}
  activity();
});

/* ══════════════════════════════════════════════════════════
   分层界面：棋盘永远是主角，其余控件按需出现、自动退场
   ══════════════════════════════════════════════════════════ */
const stageEl=$('stage'),gobanEl=$('goban'),libraryDrawer=$('libraryDrawer'),analysisDrawer=$('analysis-panel'),timelineEl=$('chart-panel'),hudInfoEl=$('hudInfo'),dockEl=$('dock'),boardSlotEl=document.querySelector('.board-slot');
const layers={library:{el:libraryDrawer,pinned:false,open:false},analysis:{el:analysisDrawer,pinned:false,open:false},timeline:{el:timelineEl,pinned:true,open:false}};
const layerLabels={library:'棋谱库',analysis:'AI 分析',timeline:'走势'};
const layerStack=[];
const rootStyle=document.documentElement.style;

function hint(text,ms=2400){const bar=$('hintBar');if(!bar)return;bar.textContent=text;bar.classList.add('show');clearTimeout(hint.timer);hint.timer=setTimeout(()=>bar.classList.remove('show'),ms)}

const cssPx=name=>parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))||0;
// 走势条的高度由目标状态直接给出，避免等 CSS 过渡算完才让位
const timelineHeight=()=>cssPx(timelineEl.classList.contains('expanded')?'--timeline-full':'--timeline-strip');
const narrowLayout=()=>window.matchMedia('(max-width:1080px)').matches;

// 棋盘两侧的悬浮件（对局信息 / 工具轨）需要多大空隙，按实测宽度算，避免面板并排时互相压住
function applyLayout(){
  const sidePinned=(layers.library.open&&layers.library.pinned)||(layers.analysis.open&&layers.analysis.pinned);
  const infoShown=!sidePinned;
  const left=layers.library.open&&layers.library.pinned?libraryDrawer.offsetWidth:0;
  const right=layers.analysis.open&&layers.analysis.pinned?analysisDrawer.offsetWidth:0;
  const bottom=layers.timeline.open?timelineHeight():0;
  rootStyle.setProperty('--inset-left',`${left}px`);
  rootStyle.setProperty('--inset-right',`${right}px`);
  rootStyle.setProperty('--inset-bottom',`${bottom}px`);
  const sideMax=Math.max(infoShown?hudInfoEl.offsetWidth:0,dockEl.offsetWidth)+18;
  const focus=document.body.classList.contains('focus');
  const reserve=narrowLayout()?22:focus?26:Math.round(sideMax*2+36);
  rootStyle.setProperty('--reserve-x',`${reserve}px`);
  document.body.classList.toggle('info-hidden',!infoShown);
  sizeGoban();
  requestAnimationFrame(()=>drawChart());
}

// 窄屏下网格行高才是真正可用的空间，直接按格子量出来给棋盘，避免绝对值兜不齐
function sizeGoban(){
  if(!narrowLayout()){
    if(gobanEl.style.width)gobanEl.style.width='';
    return;
  }
  const rect=boardSlotEl.getBoundingClientRect();
  const size=Math.max(160,Math.floor(Math.min(rect.width,rect.height)));
  if(Math.abs((parseFloat(gobanEl.style.width)||0)-size)>1)gobanEl.style.width=`${size}px`;
}

function setLayer(name,open){
  const layer=layers[name];if(!layer||layer.open===open)return;
  layer.open=open;layer.el.classList.toggle('open',open);
  const index=layerStack.indexOf(name);
  if(open&&index<0)layerStack.push(name);
  if(!open&&index>=0)layerStack.splice(index,1);
  document.querySelectorAll(`[data-dock="${name}"]`).forEach(button=>button.classList.toggle('active',open));
  applyLayout();
  if(open)hint(name==='timeline'?'走势 · Esc 关闭':'Esc 关闭 · ⇥ 固定为并排',2600);
}
function toggleLayer(name){setLayer(name,!layers[name].open)}
function layerOpen(){return layerStack.length>0}
function closeTopLayer(){const name=layerStack[layerStack.length-1];if(name)setLayer(name,false)}
function closeOverlayLayers(){['analysis','timeline','library'].forEach(name=>{if(layers[name].open&&!layers[name].pinned)setLayer(name,false)})}
function closeAllLayers(){['library','analysis','timeline'].forEach(name=>setLayer(name,false))}

function toggleLayerPin(name){
  const layer=layers[name];if(!layer)return;
  layer.pinned=!layer.pinned;
  layer.el.classList.toggle('pinned',layer.pinned);
  document.querySelectorAll(`[data-pin="${name}"]`).forEach(button=>button.classList.toggle('active',layer.pinned));
  applyLayout();
  showToast(layer.pinned?`${layerLabels[name]}已固定为并排，棋盘自动让位`:`${layerLabels[name]}改为浮在棋盘上`);
}

/* 静止一会儿就把悬浮层收起来，鼠标一动立刻回来 */
let idleTimer=null,peekTimer=null,armedAt=0;
function activity(){
  if(document.body.classList.contains('focus')){
    if(!document.body.classList.contains('hud-peek'))document.body.classList.add('hud-peek');
    clearTimeout(peekTimer);peekTimer=setTimeout(()=>document.body.classList.remove('hud-peek'),2400);
    return;
  }
  document.body.classList.remove('hud-dim');
  const now=Date.now();
  if(now-armedAt<500)return;
  armedAt=now;
  clearTimeout(idleTimer);
  idleTimer=setTimeout(()=>{if(!layerOpen()&&!document.body.classList.contains('focus'))document.body.classList.add('hud-dim')},4200);
}
document.addEventListener('pointermove',activity,{passive:true});
document.addEventListener('pointerdown',activity,{passive:true});

function setFocus(on){
  const body=document.body;
  if(body.classList.contains('focus')===on)return;
  body.classList.toggle('focus',on);
  if(on){closeAllLayers();body.classList.remove('hud-dim','hud-peek')}
  $('focusButton').classList.toggle('active',on);
  if(on){const request=document.documentElement.requestFullscreen?.();if(request&&request.catch)request.catch(()=>{})}
  else if(document.fullscreenElement){const exit=document.exitFullscreen?.();if(exit&&exit.catch)exit.catch(()=>{})}
  applyLayout();
  if(on)hint('专注模式 · 把鼠标挪到屏幕上下边缘，或按 F 唤回控件',3200);
}
document.addEventListener('fullscreenchange',()=>{
  if(!document.fullscreenElement&&document.body.classList.contains('focus')){
    document.body.classList.remove('focus');$('focusButton').classList.remove('active');applyLayout();
  }
});

function initLayers(){
  document.querySelectorAll('[data-dock]').forEach(button=>button.onclick=()=>toggleLayer(button.dataset.dock));
  document.querySelectorAll('[data-close-layer]').forEach(button=>button.onclick=()=>setLayer(button.dataset.closeLayer,false));
  document.querySelectorAll('[data-pin]').forEach(button=>button.onclick=()=>toggleLayerPin(button.dataset.pin));
  $('focusButton').onclick=()=>setFocus(!document.body.classList.contains('focus'));
  $('timelineExpandButton').onclick=()=>{
    const expanded=timelineEl.classList.toggle('expanded');
    $('timelineExpandButton').textContent=expanded?'⌄':'⌃';
    applyLayout();
  };
  // 点棋盘或空白处即收回浮层（正在落标记时除外）
  stageEl.addEventListener('pointerdown',event=>{
    if(!layerOpen())return;
    if(event.target.closest('.drawer,.dock,.player-bar,.hud-info,.hint-bar,.modal-backdrop'))return;
    if(event.target===boardCanvas&&marking)return;
    closeOverlayLayers();
  });
  if(window.ResizeObserver){
    new ResizeObserver(()=>drawBoard()).observe(gobanEl);
    new ResizeObserver(()=>sizeGoban()).observe(boardSlotEl);
    new ResizeObserver(()=>{if(layers.timeline.open)drawChart()}).observe(timelineEl);
  }
  applyLayout();drawBoard();
  setTimeout(()=>hint('⌘K 棋谱库 · A 分析 · T 走势 · F 专注',4200),700);
}

window.addEventListener('resize',()=>{applyLayout();drawBoard();drawChart()});
if (needsCollection && saveLibrary()) localStorage.setItem('yijing.collection.danghu.v1', 'true');
else if (rulesetBackfilled) saveLibrary();
renderFolders();renderTags();setShowNumbers(showNumbers,false);setShowHeat(showHeat,false);selectGame(currentGame.id);initLayers();activity();

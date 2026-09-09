const { replay, parseSgf, pointName, gtpPointToCoords } = window.YijingCore;

const baseMoves = [
  [3,15],[15,3],[15,15],[3,3],[5,2],[2,5],[16,6],[16,10],[13,16],[10,16],
  [16,13],[13,14],[10,14],[8,16],[4,16],[5,15],[4,14],[6,16],[2,16],[3,17],
  [2,14],[6,3],[8,3],[6,5],[10,3],[12,3],[11,5],[14,5],[14,7],[12,7],
  [15,8],[10,7],[9,5],[8,7],[7,5],[8,9],[10,9],[6,9],[5,7],[4,9],
  [3,7],[2,9],[5,11],[3,11],[7,11],[9,11],[11,11],[13,11],[13,9],[15,11],
  [11,13],[9,13],[7,13],[5,13],[3,13],[1,12],[1,10],[16,12],[17,14],[15,17],
  [12,17],[9,17]
].map(([x,y], i) => ({ x, y, color: i % 2 ? 'W' : 'B' }));

const games = [
  {id:1,title:'秋季升段赛 · 第 3 轮',black:'林野',blackRank:'7段',white:'陈星',whiteRank:'6段',date:'2026.08.24',event:'秋季升段赛',result:'白中盘胜',tag:'关键对局',moves:baseMoves},
  {id:2,title:'周末训练局 · 星位攻防',black:'林野',blackRank:'7段',white:'周屿',whiteRank:'7段',date:'2026.08.20',event:'训练对局',result:'黑胜 3.5目',tag:'布局研究',moves:baseMoves.slice(0,54).map((m,i)=>({...m,x:(m.x+(i>28?1:0))%19}))},
  {id:3,title:'城市联赛 · 半决赛',black:'顾言',blackRank:'职业初段',white:'林野',whiteRank:'7段',date:'2026.08.12',event:'城市联赛',result:'黑中盘胜',tag:'待复盘',moves:baseMoves.slice(0,48)},
  {id:4,title:'小目低挂定式研究',black:'林野',blackRank:'7段',white:'AI',whiteRank:'九段',date:'2026.08.08',event:'AI 训练',result:'白胜 5.5目',tag:'布局研究',moves:baseMoves.slice(0,44)},
  {id:5,title:'夏季棋友会 · 第 5 局',black:'唐宁',blackRank:'6段',white:'林野',whiteRank:'7段',date:'2026.07.30',event:'夏季棋友会',result:'白中盘胜',tag:'关键对局',moves:baseMoves.slice(0,58)},
  {id:6,title:'让先指导棋',black:'林野',blackRank:'6段',white:'沈老师',whiteRank:'职业二段',date:'2026.07.21',event:'指导棋',result:'白胜 8.5目',tag:'待复盘',moves:baseMoves.slice(0,51)}
];

let currentGame = games[0];
let currentMove = 38;
let playing = null;
let showNumbers = true;
let showHeat = true;
let mark = null;
let analyses = new Map();
let analysisRequest = 0;
let activeFolder = 'all';

const folderNames = { all: '全部棋谱', recent: '最近复盘', mine: '我的对局', professional: '职业棋谱', trash: '回收站' };

const $ = id => document.getElementById(id);
const boardCanvas = $('goBoard');
const boardCtx = boardCanvas.getContext('2d');
const chartCanvas = $('winChart');
const chartCtx = chartCanvas.getContext('2d');

function showToast(message) {
  const toast = $('toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 2300);
}

function renderGames(filter = '') {
  const query = filter.trim().toLowerCase();
  const folderMatch = (game, index) => activeFolder === 'all'
    || (activeFolder === 'recent' && index < 3)
    || (activeFolder === 'mine' && (game.black === '林野' || game.white === '林野'))
    || (activeFolder === 'professional' && `${game.blackRank} ${game.whiteRank}`.includes('职业'))
    || (activeFolder === 'trash' && game.deleted);
  const visible = games.filter((g, index) => folderMatch(g, index) && [g.title,g.black,g.white,g.event,g.tag].join(' ').toLowerCase().includes(query));
  $('gameCount').textContent = visible.length;
  $('panelTitle').textContent = folderNames[activeFolder];
  $('breadcrumbFolder').textContent = folderNames[activeFolder];
  $('gameList').innerHTML = visible.map(g => `<article class="game-card ${g.id===currentGame.id?'active':''}" data-id="${g.id}">
    <div class="date"><span>${g.date}</span><em>${g.tag}</em></div><h3>${g.title}</h3>
    <div class="matchup"><i class="mini-stone"></i><span>${g.black}</span><b>vs</b><i class="mini-stone white"></i><span>${g.white}</span></div>
    <div class="meta"><span>${g.event}</span><span>${g.result}</span></div></article>`).join('') || '<p style="padding:30px;color:#999;text-align:center">没有找到匹配的棋谱</p>';
  document.querySelectorAll('.game-card').forEach(card => card.onclick = () => selectGame(Number(card.dataset.id)));
  return visible;
}

function selectGame(id) {
  currentGame = games.find(g => g.id === id) || games[0]; currentMove = Math.min(38,currentGame.moves.length); mark = null; analyses = new Map();
  $('gameTitle').textContent=currentGame.title; $('blackName').innerHTML=`${currentGame.black} <small>${currentGame.blackRank}</small>`; $('whiteName').innerHTML=`${currentGame.white} <small>${currentGame.whiteRank}</small>`;
  $('moveSlider').max=currentGame.moves.length; $('moveTotal').textContent=currentGame.moves.length;
  renderGames($('searchInput').value); update(); analyzeCurrentPosition();
}

function drawBoard() {
  const ctx=boardCtx,w=boardCanvas.width,pad=43,step=(w-pad*2)/18;
  const gradient=ctx.createLinearGradient(0,0,w,w); gradient.addColorStop(0,'#e7c58d');gradient.addColorStop(.52,'#d9b16f');gradient.addColorStop(1,'#c99c59');ctx.fillStyle=gradient;ctx.fillRect(0,0,w,w);
  ctx.strokeStyle='rgba(64,44,21,.72)';ctx.lineWidth=1.25;
  for(let i=0;i<19;i++){const n=pad+i*step;ctx.beginPath();ctx.moveTo(pad,n);ctx.lineTo(w-pad,n);ctx.stroke();ctx.beginPath();ctx.moveTo(n,pad);ctx.lineTo(n,w-pad);ctx.stroke()}
  ctx.fillStyle='#4f371f';[3,9,15].forEach(x=>[3,9,15].forEach(y=>{ctx.beginPath();ctx.arc(pad+x*step,pad+y*step,4.2,0,Math.PI*2);ctx.fill()}));
  const board=replay(currentGame.moves,currentMove);
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

function drawChart(){const ctx=chartCtx,w=chartCanvas.width,h=chartCanvas.height,p={l:35,r:15,t:15,b:26};ctx.clearRect(0,0,w,h);ctx.font='18px "Microsoft YaHei UI"';ctx.fillStyle='#929995';ctx.strokeStyle='#e7e7e2';ctx.lineWidth=1;[0,25,50,75,100].forEach(v=>{const y=p.t+(100-v)/100*(h-p.t-p.b);ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(w-p.r,y);ctx.stroke();ctx.fillText(v+'%',0,y+5)});ctx.setLineDash([6,6]);const half=p.t+.5*(h-p.t-p.b);ctx.strokeStyle='#aeb5b0';ctx.beginPath();ctx.moveTo(p.l,half);ctx.lineTo(w-p.r,half);ctx.stroke();ctx.setLineDash([]);const max=currentGame.moves.length;const points=[...analyses.values()].map(r=>({turn:r.turnNumber,rate:toBlackWin(r,r.rootInfo.winrate)})).sort((a,b)=>a.turn-b.turn);if(points.length){ctx.beginPath();points.forEach((point,i)=>{const x=p.l+point.turn/max*(w-p.l-p.r),y=p.t+(100-point.rate)/100*(h-p.t-p.b);i?ctx.lineTo(x,y):ctx.moveTo(x,y)});ctx.strokeStyle='#2b6249';ctx.lineWidth=3;ctx.stroke();points.forEach((point,i)=>{if(i&&Math.abs(point.rate-points[i-1].rate)>10){const x=p.l+point.turn/max*(w-p.l-p.r),y=p.t+(100-point.rate)/100*(h-p.t-p.b);ctx.fillStyle='#b85d4b';ctx.beginPath();ctx.arc(x,y,6,0,Math.PI*2);ctx.fill()}})}const current=analyses.get(currentMove);if(current){const rate=toBlackWin(current,current.rootInfo.winrate),x=p.l+currentMove/max*(w-p.l-p.r),y=p.t+(100-rate)/100*(h-p.t-p.b);ctx.fillStyle='#fff';ctx.strokeStyle='#244e3c';ctx.lineWidth=4;ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.fill();ctx.stroke()}}

function renderAnalysis(){const result=currentAnalysis();if(!result){$('blackWin').textContent=$('whiteWin').textContent='--';$('evalBlack').innerHTML=$('evalWhite').innerHTML='--<sup>%</sup>';$('blackBar').style.width='0';$('leadLabel').textContent='等待分析';$('scoreLead').textContent='-- 目';$('visitsLabel').textContent='等待引擎';$('swingText').className='swing';$('swingText').textContent='当前手尚未分析';renderCandidates();return}const black=toBlackWin(result,result.rootInfo.winrate),white=100-black,lead=Number(result.rootInfo.scoreLead||0);$('blackWin').textContent=black.toFixed(1)+'%';$('whiteWin').textContent=white.toFixed(1)+'%';$('evalBlack').innerHTML=black.toFixed(1)+'<sup>%</sup>';$('evalWhite').innerHTML=white.toFixed(1)+'<sup>%</sup>';$('blackBar').style.width=black+'%';$('leadLabel').textContent=`${lead>=0?'黑棋':'白棋'}领先`;$('scoreLead').textContent=`${lead>=0?'+':''}${lead.toFixed(1)} 目`;$('visitsLabel').textContent=`访问 ${result.rootInfo.visits||0} 次`;const previous=analyses.get(currentMove-1);const delta=previous?black-toBlackWin(previous,previous.rootInfo.winrate):null;const swing=$('swingText');swing.className='swing '+(delta===null?'':delta<0?'down':'up');swing.textContent=delta===null?`KataGo · ${result.rootInfo.visits||0} 次访问`:`${delta<0?'↓':'↑'} 较上一手 ${delta>=0?'+':''}${delta.toFixed(1)}% · ${Math.abs(delta)>10?'关键手':'局面平稳'}`;renderCandidates()}
function update(){currentMove=Math.max(0,Math.min(currentMove,currentGame.moves.length));$('moveSlider').value=currentMove;$('moveNumber').textContent=currentMove;$('evalMove').textContent=currentMove;renderAnalysis();drawBoard();drawChart()}

async function requestAnalysis(turns,maxVisits){const response=await fetch('/api/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({moves:currentGame.moves,analyzeTurns:turns,maxVisits})});const body=await response.json();if(!response.ok)throw new Error(body.error||'KataGo 分析失败');return body.results}
async function analyzeCurrentPosition(){const token=++analysisRequest;$('engineStatus').className='status';$('engineStatus').innerHTML='<i></i>CUDA 分析中';$('swingText').textContent='正在等待本地 KataGo…';try{const results=await requestAnalysis([currentMove],64);if(token!==analysisRequest)return;results.forEach(result=>analyses.set(result.turnNumber,result));$('engineStatus').innerHTML='<i></i>TensorRT / CUDA';renderAnalysis();drawBoard();drawChart()}catch(error){if(token!==analysisRequest)return;$('engineStatus').className='status error';$('engineStatus').innerHTML='<i></i>引擎不可用';$('swingText').textContent=error.message;showToast(error.message)}}

function setMove(value){currentMove=Number(value);update();clearTimeout(setMove.timer);setMove.timer=setTimeout(()=>{if(!analyses.has(currentMove))analyzeCurrentPosition()},180)}
function togglePlay(){if(playing){clearInterval(playing);playing=null;$('playButton').textContent='▶';return}if(currentMove>=currentGame.moves.length)currentMove=0;$('playButton').textContent='Ⅱ';playing=setInterval(()=>{if(currentMove>=currentGame.moves.length){togglePlay();return}currentMove++;update()},Number($('speedSelect').value))}

$('searchInput').addEventListener('input',e=>renderGames(e.target.value));
$('importButton').onclick=()=>$('fileInput').click();
$('fileInput').onchange=async e=>{for(const file of e.target.files){try{const parsed=parseSgf(await file.text());games.unshift({id:Date.now()+Math.random(),tag:'新导入',...parsed,title:parsed.title||file.name});}catch(err){showToast(`${file.name}: ${err.message}`)}}renderGames();if(e.target.files.length){selectGame(games[0].id);showToast(`已导入 ${e.target.files.length} 个 SGF 文件`)}e.target.value=''};
$('moveSlider').oninput=e=>setMove(e.target.value);$('firstButton').onclick=()=>setMove(0);$('prevButton').onclick=()=>setMove(currentMove-1);$('nextButton').onclick=()=>setMove(currentMove+1);$('lastButton').onclick=()=>setMove(currentGame.moves.length);$('playButton').onclick=togglePlay;
$('speedSelect').onchange=()=>{if(playing){togglePlay();togglePlay()}};
$('numberToggle').onclick=e=>{showNumbers=!showNumbers;e.currentTarget.classList.toggle('active',showNumbers);drawBoard()};$('heatToggle').onclick=e=>{showHeat=!showHeat;e.currentTarget.classList.toggle('active',showHeat);drawBoard()};$('markButton').onclick=()=>showToast('点击棋盘交叉点添加三角标记');
boardCanvas.onclick=e=>{const rect=boardCanvas.getBoundingClientRect(),scale=boardCanvas.width/rect.width,step=(boardCanvas.width-86)/18;const x=Math.round((e.offsetX*scale-43)/step),y=Math.round((e.offsetY*scale-43)/step);if(x>=0&&x<19&&y>=0&&y<19){mark={x,y};drawBoard();showToast(`已标记 ${pointName(x,y)}`)}};
document.querySelectorAll('.folder').forEach(button=>button.onclick=()=>{activeFolder=button.dataset.folder;document.querySelectorAll('.folder').forEach(item=>item.classList.toggle('active',item===button));document.querySelectorAll('.tags button').forEach(item=>item.classList.remove('active'));$('searchInput').value='';const visible=renderGames();if(visible.length&&!visible.some(game=>game.id===currentGame.id))selectGame(visible[0].id)});
document.querySelectorAll('.tags button').forEach(btn=>btn.onclick=()=>{$('searchInput').value=btn.dataset.tag;renderGames(btn.dataset.tag);document.querySelectorAll('.tags button').forEach(b=>b.classList.remove('active'));btn.classList.add('active')});
$('analyzeButton').onclick=async()=>{const button=$('analyzeButton'),progress=$('analysisProgress');button.disabled=true;$('analysisLabel').textContent='CUDA 正在分析整局…';$('analysisMeta').textContent='请稍候';progress.className='loading';try{const turns=Array.from({length:currentGame.moves.length+1},(_,i)=>i),results=await requestAnalysis(turns,24);results.forEach(result=>analyses.set(result.turnNumber,result));$('analysisLabel').textContent='全局分析已完成';$('analysisMeta').textContent=`${results.length} / ${turns.length} 手`;button.textContent='重新分析';update();showToast('KataGo 整局分析完成')}catch(error){$('analysisLabel').textContent='分析失败';$('analysisMeta').textContent=error.message;showToast(error.message)}finally{button.disabled=false;progress.className='';progress.style.width=analyses.size?`${analyses.size/(currentGame.moves.length+1)*100}%`:'0'}};
document.addEventListener('keydown',e=>{if(e.target.matches('input,textarea'))return;if(e.key==='ArrowLeft')setMove(currentMove-1);if(e.key==='ArrowRight')setMove(currentMove+1);if(e.key===' ') {e.preventDefault();togglePlay()}});

renderGames();update();analyzeCurrentPosition();

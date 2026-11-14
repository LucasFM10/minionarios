(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const hhmm = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dt = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const ago = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    if (m < 1) return 'agora'; if (m < 60) return `há ${m} min`;
    const h = Math.floor(m / 60); if (h < 24) return `há ${h}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
    return dt(iso);
  };
  const phoneFmt = (p) => { const d = String(p).replace(/^55/, ''); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : p; };
  const ls = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

  let statuses = [], orders = [], stats = null, knownIds = null, poll = null;
  let q = '', recv = 'all', view = ls.get('adm_view', innerWidth < 860 ? 'list' : 'board'), sound = ls.get('adm_sound', true);
  let openId = null;
  const FLOW = ['pedido_feito', 'pagamento_confirmado', 'em_preparo', 'saiu_para_entrega', 'concluido'];
  const sInfo = (k) => statuses.find((s) => s.key === k) || { key: k, label: k, emoji: '' };
  const COLOR = { pedido_feito: '#E58A1F', pagamento_confirmado: '#2F6FDB', em_preparo: '#C99700', saiu_para_entrega: '#7B4FD6', concluido: '#1E8E4E', cancelado: '#C83839' };
  const HINT = { pedido_feito: 'Aguardando comprovante / conferência', pagamento_confirmado: 'Pago — aguardando preparo', em_preparo: 'Na chapa', saiu_para_entrega: 'Pronto / a caminho', concluido: 'Entregue ou retirado', cancelado: '' };
  const NEXT_LABEL = { pedido_feito: 'Confirmar Pix', pagamento_confirmado: 'Iniciar preparo', em_preparo: 'Pronto / saiu', saiu_para_entrega: 'Concluir' };

  function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), 2200); }
  async function api(path, opts = {}) {
    const r = await fetch(path, opts);
    if (r.status === 401) { showLogin(); throw new Error('Sessão expirada'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Erro');
    return j;
  }
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  /* ---------- auth ---------- */
  function showLogin() { clearInterval(poll); $('#app').hidden = true; $('#login').hidden = false; setTimeout(() => $('#pw').focus(), 50); }
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault(); $('#loginErr').textContent = '';
    const r = await fetch('/api/admin/login', json('POST', { password: $('#pw').value }));
    if (!r.ok) return ($('#loginErr').textContent = (await r.json()).error || 'Senha incorreta');
    start();
  };
  $('#logout').onclick = async () => { await fetch('/api/admin/logout', { method: 'POST' }); showLogin(); };
  function start() {
    $('#login').hidden = true; $('#app').hidden = false;
    applyView(); paintSound(); loadOrders(); refreshWaDot();
    clearInterval(poll);
    poll = setInterval(() => { if (document.visibilityState === 'visible') { loadOrders(); } }, 5000);
    setInterval(refreshWaDot, 60000);
  }

  /* ---------- nav ---------- */
  const tab = () => $('#nav .on').dataset.tab;
  $('#nav').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#nav button').forEach((x) => x.classList.toggle('on', x === b));
    $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== b.dataset.tab));
    ({ orders: loadOrders, summary: loadSummary, products: loadProducts, settings: loadSettings, whatsapp: loadWa })[b.dataset.tab]();
    scrollTo(0, 0);
  };

  /* ---------- sound ---------- */
  let ac;
  function beep() {
    if (!sound) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      [0, .16, .32].forEach((t, i) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = [880, 1175, 1568][i]; g.gain.setValueAtTime(.18, ac.currentTime + t); g.gain.exponentialRampToValueAtTime(.001, ac.currentTime + t + .15); o.connect(g).connect(ac.destination); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + .16); });
      navigator.vibrate?.([120, 60, 120]);
    } catch {}
  }
  document.addEventListener('click', () => { try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); } catch {} }, { once: true });
  function paintSound() { $('#soundBtn').textContent = sound ? '🔔 Som ligado' : '🔕 Som desligado'; }
  $('#soundBtn').onclick = () => { sound = !sound; ls.set('adm_sound', sound); paintSound(); if (sound) beep(); };

  /* ---------- orders ---------- */
  async function loadOrders() {
    let j; try { j = await api('/api/admin/orders'); } catch { return; }
    statuses = j.statuses; stats = j.stats;
    const fresh = knownIds ? j.orders.filter((o) => !knownIds.has(o.id)) : [];
    knownIds = new Set(j.orders.map((o) => o.id));
    orders = j.orders;
    if (fresh.length) {
      beep(); toast(`🔔 ${fresh.length === 1 ? `Novo pedido #${fresh[0].number_label} — ${fresh[0].customer_name}` : `${fresh.length} novos pedidos`}`);
      document.title = `(${fresh.length}) Novo pedido · Minionários`; setTimeout(() => (document.title = 'Painel · Minionários'), 8000);
    }
    const pending = orders.filter((o) => o.status === 'pedido_feito').length;
    $('#navBadge').hidden = !pending; $('#navBadge').textContent = pending;
    $('#liveInfo').innerHTML = `<span class="live"></span>Ao vivo · atualizado às ${hhmm(new Date().toISOString())}`;
    if (tab() === 'orders') { renderKpis(); renderOrders(new Set(fresh.map((o) => o.id))); }
    if (openId && !$('#drawer').classList.contains('on')) openId = null;
  }

  function renderKpis() {
    const act = orders.filter((o) => o.status !== 'cancelado');
    const waiting = orders.filter((o) => o.status === 'pedido_feito');
    const withReceipt = waiting.filter((o) => o.has_receipt).length;
    const prod = orders.filter((o) => ['pagamento_confirmado', 'em_preparo'].includes(o.status)).length;
    $('#kpis').innerHTML = `
      <div class="kpi"><span>Pedidos</span><b>${act.length}</b><small>${orders.length - act.length} cancelado(s)</small></div>
      <div class="kpi ${withReceipt ? 'alert' : ''}"><span>Aguardando conferência</span><b>${waiting.length}</b><small>${withReceipt} com comprovante para conferir</small></div>
      <div class="kpi"><span>Na fila de produção</span><b>${prod}</b><small>pagos ou em preparo</small></div>
      <div class="kpi"><span>Pagamentos confirmados</span><b>${brl(stats.totals.confirmed)}</b><small>de ${brl(stats.totals.gross)} em pedidos</small></div>`;
  }

  const filtered = () => {
    const t = q.trim().toLowerCase(), digits = t.replace(/\D/g, '');
    return orders.filter((o) => {
      if (recv !== 'all' && (o.delivery_mode || 'retirada') !== recv) return false;
      if (!t) return true;
      return o.customer_name.toLowerCase().includes(t) || (o.bairro || '').toLowerCase().includes(t) || (digits && (o.phone.includes(digits) || o.number === +digits));
    });
  };
  const itemsTxt = (o) => o.items.map((l) => `${l.qty}× ${l.name}`).join(' · ');
  function tagsHtml(o) {
    const t = [];
    t.push(o.delivery_mode === 'entrega' ? `<span class="tag deliv">🛵 ${esc(o.bairro || 'Entrega')}</span>` : `<span class="tag">🏠 Retirada</span>`);
    if (o.has_receipt) t.push(`<span class="tag ok">🧾 Comprovante</span>`);
    else if (o.status === 'pedido_feito') t.push(o.source === 'site' && !o.wa_jid ? `<span class="tag bad">Aguardando WhatsApp</span>` : `<span class="tag warn">Sem comprovante</span>`);
    if (o.source === 'whatsapp') t.push(`<span class="tag">💬 Bot</span>`);
    if (o.source === 'admin') t.push(`<span class="tag">✍️ Manual</span>`);
    if (o.notes) t.push(`<span class="tag warn">📝 Obs.</span>`);
    return t.join('');
  }
  function cardHtml(o, fresh) {
    const nx = FLOW[FLOW.indexOf(o.status) + 1];
    return `<article class="ocard ${fresh ? 'fresh' : ''}" data-id="${o.id}">
      <div class="oc-top"><span class="oc-num">#${o.number_label}</span><span class="oc-time" title="${dt(o.created_at)}">${ago(o.created_at)}</span></div>
      <div class="oc-name">${esc(o.customer_name)}</div>
      <p class="oc-items">${esc(itemsTxt(o))}</p>
      <div class="oc-tags">${tagsHtml(o)}</div>
      <div class="oc-foot"><span class="oc-total">${brl(o.total_cents)}</span>${nx ? `<button class="oc-next" data-adv="${o.id}:${nx}">${NEXT_LABEL[o.status]} →</button>` : ''}</div>
    </article>`;
  }
  function renderOrders(freshIds = new Set()) {
    const list = filtered();
    if (view === 'board') {
      const cols = [...FLOW, 'cancelado'];
      $('#board').innerHTML = cols.map((k) => {
        const items = list.filter((o) => o.status === k);
        if (k === 'cancelado' && !items.length) return '';
        const s = sInfo(k);
        return `<div class="col c-${k}"><div class="col-h"><span class="sw st-${k}"></span><div>${esc(s.label)}<small>${HINT[k]}</small></div><span class="ct">${items.length}</span></div>
          <div class="col-body">${items.length ? items.map((o) => cardHtml(o, freshIds.has(o.id))).join('') : `<div class="col-empty">Nenhum pedido</div>`}</div></div>`;
      }).join('');
    } else {
      $('#list').innerHTML = !list.length ? `<div class="empty-state"><b>Nenhum pedido encontrado</b>Os pedidos aparecem aqui assim que forem feitos.</div>` :
        `<div class="lrow head"><span>Nº</span><span>Cliente</span><span>Itens</span><span style="text-align:right">Total</span><span>Status</span><span>Hora</span></div>` +
        list.map((o) => `<div class="lrow" data-id="${o.id}"><span class="num">#${o.number_label}</span><span><b>${esc(o.customer_name)}</b><br><small class="muted">${o.delivery_mode === 'entrega' ? '🛵 ' + esc(o.bairro) : '🏠 Retirada'}</small><br><span class="pill mst st-${o.status}">${esc(sInfo(o.status).label)}</span></span><span class="it">${esc(itemsTxt(o))}</span><span class="tot">${brl(o.total_cents)}</span><span><span class="pill st-${o.status}">${esc(sInfo(o.status).label)}</span></span><span class="muted">${ago(o.created_at)}</span></div>`).join('');
    }
  }
  function applyView() {
    $$('#viewToggle button').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
    $('#board').hidden = view !== 'board'; $('#list').hidden = view !== 'list';
  }
  $('#viewToggle').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; view = b.dataset.v; ls.set('adm_view', view); applyView(); renderOrders(); };
  $('#recvFilter').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; recv = b.dataset.r; $$('#recvFilter button').forEach((x) => x.classList.toggle('on', x === b)); renderOrders(); };
  $('#q').oninput = (e) => { q = e.target.value; renderOrders(); };

  async function setStatus(id, status, opts = {}) {
    if (status === 'cancelado' && !confirm('Cancelar este pedido?')) return;
    try {
      const { order } = await api(`/api/admin/orders/${id}`, json('PATCH', { status }));
      const i = orders.findIndex((o) => o.id === order.id); if (i >= 0) orders[i] = order;
      toast(`#${order.number_label} → ${order.status_info.label}`);
      renderKpis(); renderOrders();
      if (openId === order.id && !opts.keepClosed) openOrder(order.id);
      loadOrders();
    } catch (e) { toast(e.message); }
  }
  const onBoardClick = (e) => {
    const adv = e.target.closest('[data-adv]');
    if (adv) { e.stopPropagation(); const [id, st] = adv.dataset.adv.split(':'); return setStatus(+id, st, { keepClosed: true }); }
    const c = e.target.closest('[data-id]'); if (c) openOrder(+c.dataset.id);
  };
  $('#board').onclick = onBoardClick; $('#list').onclick = onBoardClick;

  /* ---------- drawer ---------- */
  function closeDrawer() { $('#drawer').classList.remove('on'); $('#scrim').classList.remove('on'); setTimeout(() => ($('#scrim').hidden = true), 200); openId = null; }
  $('#scrim').onclick = closeDrawer;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if ($('#modal').open) return; closeDrawer(); } });
  async function openOrder(id) {
    openId = id;
    let j; try { j = await api(`/api/admin/orders/${id}`); } catch (e) { return toast(e.message); }
    const o = j.order, ev = j.events, ent = o.delivery_mode === 'entrega';
    const idx = FLOW.indexOf(o.status);
    const rUrl = `/api/admin/orders/${o.id}/receipt`;
    const waMsg = `Olá, ${o.customer_name.split(' ')[0]}! Aqui é a equipe Minionários sobre o seu pedido #${o.number_label}.`;
    $('#drawer').innerHTML = `
      <div class="dr-h"><h2>#${o.number_label}</h2><span class="pill st-${o.status}">${esc(o.status_info.label)}</span><button class="x" id="drX" aria-label="Fechar">✕</button></div>
      <div class="dr-b">
        <div class="sec"><h3>Status</h3><div class="stepper">${FLOW.map((k, i) => `<button data-st="${k}" class="${o.status === 'cancelado' ? '' : i < idx ? 'done' : i === idx ? 'cur' : ''}"><i>${sInfo(k).emoji}</i>${esc(sInfo(k).label)}</button>`).join('')}</div></div>
        <div class="sec"><h3>Cliente</h3><dl class="kv">
          <dt>Nome</dt><dd>${esc(o.customer_name)}</dd>
          <dt>Telefone</dt><dd><a href="https://wa.me/${esc(o.phone)}?text=${encodeURIComponent(waMsg)}" target="_blank" rel="noopener">${esc(phoneFmt(o.phone))} ↗</a></dd>
          <dt>Recebimento</dt><dd>${ent ? `🛵 Entrega · ${esc(o.bairro)}` : '🏠 Retirada no local'}</dd>
          ${ent ? `<dt>Endereço</dt><dd>${esc(o.address)}${o.address_ref ? `<br><span class="muted">${esc(o.address_ref)}</span>` : ''}</dd>` : ''}
          <dt>Origem</dt><dd>${o.source === 'whatsapp' ? 'Bot do WhatsApp' : o.source === 'admin' ? 'Manual (painel)' : 'Site'}${o.source === 'site' ? (o.wa_jid ? ' · confirmou no WhatsApp' : ' · <span style="color:var(--s6)">ainda não confirmou no WhatsApp</span>') : ''}</dd>
          <dt>Feito em</dt><dd>${dt(o.created_at)}</dd>
        </dl></div>
        <div class="sec"><h3>Itens</h3><div class="items">
          ${o.items.map((l) => `<div class="r"><span><span class="q">${l.qty}×</span>${esc(l.name)}</span><span>${brl(l.subtotal_cents)}</span></div>`).join('')}
          ${ent ? `<div class="r"><span>Taxa de entrega</span><span>${o.delivery_fee_cents == null ? 'a combinar' : brl(o.delivery_fee_cents)}</span></div>` : ''}
          <div class="r t"><span>Total (Pix)</span><span>${brl(o.total_cents)}</span></div>
        </div></div>
        ${o.notes ? `<div class="sec"><h3>Observação</h3><div class="note">📝 ${esc(o.notes)}</div></div>` : ''}
        <div class="sec"><h3>Comprovante do Pix</h3>${o.receipt_path
          ? `<div class="receipt">${o.receipt_mime === 'application/pdf' ? `<iframe src="${rUrl}"></iframe>` : `<a href="${rUrl}" target="_blank"><img src="${rUrl}" alt="Comprovante" /></a>`}<div class="rf"><span class="muted">Confira valor (${brl(o.total_cents)}), data e recebedor</span><a class="btn sm" href="${rUrl}" target="_blank">Abrir ↗</a></div></div>`
          : `<div class="noreceipt">Nenhum comprovante ainda.<br><small>${o.source === 'site' && !o.wa_jid ? 'O cliente ainda não concluiu o pedido no WhatsApp.' : 'O cliente envia pelo WhatsApp.'}</small></div>`}</div>
        <div class="sec"><h3>Histórico</h3><ul class="tl">${ev.map((e) => `<li style="--c:${COLOR[e.status] || '#ccc'}"><span>${esc(sInfo(e.status).label)}</span><time>${dt(e.created_at)}</time></li>`).join('')}</ul></div>
      </div>
      <div class="dr-f">
        ${o.status === 'cancelado' ? `<button class="btn" data-st="pedido_feito">Reabrir pedido</button>`
          : `<button class="btn danger" data-st="cancelado">Cancelar</button>${FLOW[idx + 1] ? `<button class="btn ${o.status === 'pedido_feito' ? 'green' : 'primary'}" data-st="${FLOW[idx + 1]}">${NEXT_LABEL[o.status]} →</button>` : `<button class="btn" disabled>Pedido concluído ✓</button>`}`}
      </div>`;
    $('#drX').onclick = closeDrawer;
    $('#drawer').onclick = (e) => { const b = e.target.closest('[data-st]'); if (b && b.dataset.st !== o.status) setStatus(o.id, b.dataset.st); };
    $('#scrim').hidden = false; requestAnimationFrame(() => { $('#scrim').classList.add('on'); $('#drawer').classList.add('on'); });
  }

  /* ---------- modal ---------- */
  function modal(title, html) {
    $('#modalBody').innerHTML = `<div class="mh"><h3>${esc(title)}</h3><button class="x" data-close>✕</button></div>${html}`;
    $('#modal').showModal();
    $$('[data-close]', $('#modalBody')).forEach((b) => (b.onclick = () => $('#modal').close()));
  }
  $('#modal').onclick = (e) => { if (e.target === $('#modal')) $('#modal').close(); };

  /* novo pedido manual */
  $('#newOrder').onclick = async () => {
    const { products } = await api('/api/admin/products');
    const act = products.filter((p) => p.active), qty = {};
    modal('Novo pedido', `<form id="mo">
      <div class="row2"><label class="fld"><span>Nome</span><input class="inp" name="customer_name" required /></label><label class="fld"><span>Telefone</span><input class="inp" name="phone" type="tel" required placeholder="(83) 9 0000-0000" /></label></div>
      <div class="fld"><span>Itens</span>${act.map((p) => `<div class="mline"><div class="nm">${esc(p.name)}<small>${brl(p.price_cents)}</small></div><div class="qty"><button type="button" data-d="${p.id}">−</button><span id="q${p.id}">0</span><button type="button" data-i="${p.id}">+</button></div></div>`).join('')}</div>
      <label class="fld"><span>Observação</span><input class="inp" name="notes" /></label>
      <label class="fld"><span>Status inicial</span><select class="inp" name="status">${statuses.filter((s) => s.key !== 'cancelado').map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join('')}</select><small>Retirada no local. Use "Pagamento confirmado" para pedidos já pagos no balcão.</small></label>
      <button class="btn primary block" id="moBtn">Criar pedido</button><p class="err" id="moErr"></p></form>`);
    $('#mo').onclick = (e) => {
      const i = e.target.closest('[data-i]'), d = e.target.closest('[data-d]');
      const id = (i || d)?.dataset.i || (i || d)?.dataset.d; if (!id) return;
      qty[id] = Math.max(0, (qty[id] || 0) + (i ? 1 : -1)); $('#q' + id).textContent = qty[id];
      const tot = act.reduce((s, p) => s + (qty[p.id] || 0) * p.price_cents, 0); $('#moBtn').textContent = tot ? `Criar pedido · ${brl(tot)}` : 'Criar pedido';
    };
    $('#mo').onsubmit = async (e) => {
      e.preventDefault(); const f = new FormData(e.target);
      const items = Object.entries(qty).filter(([, v]) => v > 0).map(([k, v]) => ({ product_id: +k, qty: v }));
      try {
        const { order } = await api('/api/admin/orders', json('POST', { customer_name: f.get('customer_name'), phone: f.get('phone'), notes: f.get('notes'), status: f.get('status'), items }));
        $('#modal').close(); toast(`Pedido #${order.number_label} criado`); knownIds?.add(order.id); loadOrders();
      } catch (err) { $('#moErr').textContent = err.message; }
    };
  };

  /* ---------- resumo ---------- */
  async function loadSummary() {
    const j = await api('/api/admin/orders'); const st = j.stats, all = j.orders; statuses = j.statuses;
    const t = st.totals, act = all.filter((o) => o.status !== 'cancelado');
    const prods = Object.entries(st.products).sort((a, b) => b[1] - a[1]); const max = Math.max(1, ...prods.map((p) => p[1]));
    const burgers = prods.reduce((s, [n, q]) => s + q * (/duplo/i.test(n) ? 2 : /papoiburg|combo/i.test(n) ? 1 : 0), 0);
    const fries = prods.reduce((s, [n, q]) => s + q * (/papatata|power|fominion/i.test(n) ? 1 : 0), 0);
    const ent = act.filter((o) => o.delivery_mode === 'entrega');
    const fees = ent.reduce((s, o) => s + (o.delivery_fee_cents || 0), 0);
    const ticket = act.length ? Math.round(t.gross / act.length) : 0;
    const counts = [...FLOW, 'cancelado'].map((k) => [k, all.filter((o) => o.status === k).length]);
    $('#summary').innerHTML = `
      <div class="sum-grid">
        <div class="kpi"><span>Arrecadado (confirmado)</span><b>${brl(t.confirmed)}</b><small>de ${brl(t.gross)} em pedidos</small></div>
        <div class="kpi"><span>Pedidos ativos</span><b>${act.length}</b><small>ticket médio ${brl(ticket)}</small></div>
        <div class="kpi"><span>Hambúrgueres a produzir</span><b>${burgers}</b><small>${fries} porções de fritas</small></div>
        <div class="kpi"><span>Entregas</span><b>${ent.length}</b><small>${brl(fees)} em taxas</small></div>
      </div>
      <div class="two">
        <div class="card"><h3>Itens vendidos</h3><div class="bars">${prods.length ? prods.map(([n, qn]) => `<div class="b"><span>${esc(n)}</span><div class="track"><div class="fill" style="width:${(qn / max) * 100}%"></div></div><span class="n">${qn}</span></div>`).join('') : '<p class="muted">Sem vendas ainda.</p>'}</div>
          <p class="muted" style="margin:10px 0 0;font-size:12px">Estimativa de produção: Papoiburg e combos = 1 hambúrguer; Minion Duplo = 2.</p></div>
        <div class="card"><h3>Pedidos por status</h3>
          <div class="stack">${counts.filter(([, n]) => n).map(([k, n]) => `<div style="width:${(n / Math.max(1, all.length)) * 100}%;background:${COLOR[k]}"></div>`).join('')}</div>
          <div class="legend">${counts.map(([k, n]) => `<div><span class="sw" style="background:${COLOR[k]}"></span>${esc(sInfo(k).label)}<b>${n}</b></div>`).join('')}</div></div>
      </div>`;
  }

  /* ---------- cardápio ---------- */
  let prodCache = [];
  async function loadProducts() {
    const { products } = await api('/api/admin/products'); prodCache = products;
    $('#products').innerHTML = products.map((p) => `
      <div class="prod ${p.active ? '' : 'off'}">
        <div class="ph" style="${p.image_url ? `background-image:url('${p.image_url}')` : ''}">${p.image_url ? '' : esc(p.emoji)}${p.featured ? `<span class="badge">★ ${esc(p.badge || 'Destaque')}</span>` : ''}${p.active ? '' : '<span class="hid">Oculto</span>'}</div>
        <div class="bd"><h3>${esc(p.name)}</h3><span class="ds">${esc(p.description) || '&nbsp;'}</span>
          <div class="ft"><div><div class="pr">${brl(p.price_cents)}</div><div class="cat">${esc(p.category)}</div></div><button class="btn sm" data-edit="${p.id}">Editar</button></div></div>
      </div>`).join('');
  }
  $('#products').onclick = (e) => { const b = e.target.closest('[data-edit]'); if (b) productForm(prodCache.find((p) => p.id === +b.dataset.edit)); };
  $('#addProduct').onclick = () => productForm(null);
  function productForm(p) {
    modal(p ? 'Editar item' : 'Novo item', `<form id="pf">
      <label class="fld"><span>Nome</span><input class="inp" name="name" required value="${esc(p?.name || '')}" /></label>
      <label class="fld"><span>Descrição</span><input class="inp" name="description" value="${esc(p?.description || '')}" /></label>
      <div class="row2">
        <label class="fld"><span>Preço (R$)</span><input class="inp" name="price" inputmode="decimal" required value="${p ? (p.price_cents / 100).toFixed(2).replace('.', ',') : ''}" /></label>
        <label class="fld"><span>Categoria</span><input class="inp" name="category" value="${esc(p?.category || 'Combos')}" /></label>
        <label class="fld"><span>Ordem</span><input class="inp" name="sort" type="number" value="${p?.sort ?? 99}" /></label>
        <label class="fld"><span>Emoji (sem foto)</span><input class="inp" name="emoji" value="${esc(p?.emoji || '🍔')}" /></label>
      </div>
      <label class="fld"><span>Foto</span><input class="inp" type="file" name="image" accept="image/*" style="padding-top:8px" /></label>
      ${p?.image_url && !p.image_url.startsWith('/img/') ? `<label class="chk"><input type="checkbox" name="remove_image" value="1" /> Remover foto enviada</label>` : ''}
      <label class="chk"><input type="checkbox" name="active" ${!p || p.active ? 'checked' : ''} /> Visível no cardápio</label>
      <label class="chk"><input type="checkbox" name="featured" ${p?.featured ? 'checked' : ''} /> Mostrar em Destaques</label>
      <label class="fld"><span>Selo do destaque</span><input class="inp" name="badge" maxlength="24" placeholder="Ex.: Mais completo" value="${esc(p?.badge || '')}" /></label>
      <button class="btn primary block">Salvar</button><p class="err" id="pfErr"></p></form>`);
    $('#pf').onsubmit = async (e) => {
      e.preventDefault(); const fd = new FormData(e.target);
      fd.set('active', e.target.active.checked ? '1' : '0'); fd.set('featured', e.target.featured.checked ? '1' : '0');
      if (!fd.get('image')?.size) fd.delete('image');
      try { await api(p ? `/api/admin/products/${p.id}` : '/api/admin/products', { method: p ? 'PUT' : 'POST', body: fd }); $('#modal').close(); toast('Cardápio atualizado'); loadProducts(); }
      catch (err) { $('#pfErr').textContent = err.message; }
    };
  }

  /* ---------- ajustes ---------- */
  async function loadSettings() {
    const { settings: s } = await api('/api/admin/settings');
    const f = (k, label, extra = '', help = '') => `<label class="fld"><span>${label}</span><input class="inp" name="${k}" value="${esc(s[k])}" ${extra} />${help ? `<small>${help}</small>` : ''}</label>`;
    const sw = (k, label, help) => `<div class="sw-row"><div><b>${label}</b><small>${help}</small></div><label class="toggle"><input type="checkbox" data-bool="${k}" ${s[k] === '1' ? 'checked' : ''} /><i></i></label></div>`;
    $('#settingsForm').innerHTML = `
      <div class="card"><h3>Vendas</h3><p>Controle da pré-venda e do atendimento.</p>
        ${sw('accepting_orders', 'Pré-venda aberta', 'Quando desligado, o cardápio fica só para consulta.')}
        ${sw('delivery_enabled', 'Oferecer entrega', 'Mostra a opção "Receber em casa" com taxa por bairro.')}
        ${sw('notify_status_whatsapp', 'Avisar cliente no WhatsApp', 'Envia mensagem automática quando o status do pedido muda.')}
        <div style="margin-top:12px">${f('next_order_number', 'Próximo número de pedido', 'type="number" min="1" max="999"')}</div>
      </div>
      <div class="card"><h3>Pix</h3><p>Dados usados para gerar o QR Code e o copia e cola.</p>
        ${f('pix_key', 'Chave Pix', '', 'Telefone no formato +55DDDNÚMERO (ex.: +5583987889174).')}
        <div class="row2">${f('pix_name', 'Nome do recebedor')}${f('pix_city', 'Cidade', 'maxlength="15"')}</div>
      </div>
      <div class="card"><h3>Retirada e entrega</h3><p>Aparece no topo do cardápio e no fechamento do pedido.</p>
        <div class="row2">${f('pickup_address', 'Endereço de retirada')}${f('pickup_city', 'Cidade (para o mapa)')}</div>
        ${f('delivery_note', 'Texto da entrega')}
        ${f('location_note', 'Aviso de local', '', 'Usado só se não houver endereço de retirada.')}
      </div>
      <div class="card"><h3>Página</h3><p>Identidade da equipe no cardápio.</p>
        <div class="row2">${f('team_name', 'Nome da equipe')}${f('instagram', 'Instagram (sem @)')}</div>
        <div class="row2">${f('tagline', 'Chamada')}${f('subtitle', 'Subtítulo')}</div>
        <div class="row2">${f('event_date_label', 'Data')}${f('pickup_label', 'Selo de recebimento')}</div>
        ${f('whatsapp_number', 'WhatsApp da equipe (com 55)', '', 'Destino do botão "Concluir pedido no WhatsApp".')}
        <div class="row2"><label class="fld"><span>Foto de perfil</span><input class="inp" type="file" name="avatar" accept="image/*" style="padding-top:8px" /></label><label class="fld"><span>Capa</span><input class="inp" type="file" name="cover" accept="image/*" style="padding-top:8px" /></label></div>
        <div class="imgs">${s.avatar_url ? `<img src="${s.avatar_url}" style="border-radius:50%;width:56px" />` : ''}${s.cover_url ? `<img src="${s.cover_url}" />` : ''}</div>
      </div>
      <div class="save-bar"><button class="btn primary" style="height:44px;padding:0 22px">Salvar ajustes</button></div>`;
  }
  $('#settingsForm').onsubmit = async (e) => {
    e.preventDefault(); const fd = new FormData(e.target);
    $$('[data-bool]', e.target).forEach((c) => fd.set(c.dataset.bool, c.checked ? '1' : '0'));
    for (const k of ['avatar', 'cover']) if (!fd.get(k)?.size) fd.delete(k);
    try { await api('/api/admin/settings', { method: 'PUT', body: fd }); toast('Ajustes salvos ✓'); loadSettings(); } catch (err) { toast(err.message); }
  };

  /* ---------- whatsapp ---------- */
  const WA_LABEL = { open: 'Conectado', connecting: 'Aguardando leitura do QR Code', close: 'Desconectado', not_created: 'Instância não encontrada', unknown: 'Desconhecido' };
  async function refreshWaDot() {
    try { const w = await api('/api/admin/whatsapp'); const d = $('#waDot'); d.className = 'dot ' + (w.state === 'open' ? 'open' : w.configured ? 'bad' : ''); } catch {}
  }
  let qrTimer;
  async function loadWa() {
    clearInterval(qrTimer);
    const w = await api('/api/admin/whatsapp');
    if (!w.configured) { $('#wa').innerHTML = `<div class="card"><h3>Não configurado</h3><p class="muted">Defina <code class="k">EVOLUTION_URL</code>, <code class="k">EVOLUTION_API_KEY</code> e <code class="k">PUBLIC_URL</code> nas variáveis do app.</p></div>`; return; }
    $('#wa').innerHTML = `
      <div class="card">
        <div class="wa-status"><span class="big ${w.state}"></span><div><b>${WA_LABEL[w.state] || esc(w.state)}</b><br><small class="muted">Instância <code class="k">${esc(w.instance)}</code></small></div></div>
        ${w.error ? `<p class="err">${esc(w.error)}</p>` : ''}
        <div class="actions">
          ${w.state !== 'open' ? `<button class="btn primary" id="waQr">${w.exists ? 'Conectar (QR Code / código)' : 'Criar instância e conectar'}</button>` : `<button class="btn danger" id="waOut">Desconectar</button>`}
          <button class="btn" id="waSetup">Reconfigurar webhook</button>
        </div>
        <div id="qrArea" style="margin-top:16px"></div>
        <p class="muted" style="font-size:12px;margin:14px 0 0">Webhook: <code class="k">${esc(w.webhook || '')}</code></p>
      </div>
      <div class="card"><h3>Como conectar</h3>
        <ol class="steps-ol"><li>No celular com o WhatsApp da equipe: <b>Configurações › Aparelhos conectados › Conectar um aparelho</b>.</li><li>Leia o QR Code (ou toque em <b>Conectar com número de telefone</b> e digite o código).</li><li>O status muda para <b>Conectado</b>. Teste mandando "oi" de outro celular.</li></ol>
      </div>
      <div class="card"><h3>O que o bot faz</h3>
        <ol class="steps-ol"><li>Recebe a mensagem "Quero confirmar meu pedido #012…" vinda do site e envia o Pix.</li><li>Pede e anexa o comprovante ao pedido.</li><li><b>2</b> ou <b>status</b>: mostra o status; <b>1</b>: faz pedido pelo chat; <b>menu</b>: opções.</li></ol>
      </div>`;
    const qb = $('#waQr'); if (qb) qb.onclick = async () => { if (!w.exists) { try { await api('/api/admin/whatsapp/setup', { method: 'POST' }); } catch (e) { return toast(e.message); } } showQr(); };
    $('#waSetup').onclick = async () => { try { await api('/api/admin/whatsapp/setup', { method: 'POST' }); toast('Webhook configurado'); loadWa(); } catch (e) { toast(e.message); } };
    const out = $('#waOut'); if (out) out.onclick = async () => { if (confirm('Desconectar o WhatsApp do bot?')) { await api('/api/admin/whatsapp/logout', { method: 'POST' }).catch((e) => toast(e.message)); loadWa(); refreshWaDot(); } };
  }
  async function showQr() {
    const draw = async () => {
      try {
        const s = await api('/api/admin/whatsapp');
        if (s.state === 'open') { clearInterval(qrTimer); toast('WhatsApp conectado ✓'); refreshWaDot(); return loadWa(); }
        const r = await api('/api/admin/whatsapp/qr');
        $('#qrArea').innerHTML = `<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center">${r.base64 ? `<div class="qrbox"><img src="${r.base64}" alt="QR Code" /></div>` : '<p class="muted">Gerando QR Code…</p>'}
          ${r.pairingCode ? `<div><p class="muted" style="margin:0 0 6px">Ou digite este código no celular:</p><div class="paircode">${esc(r.pairingCode)}</div></div>` : ''}</div><p class="muted" style="font-size:12px">Atualiza sozinho a cada 20 segundos.</p>`;
      } catch (e) { $('#qrArea').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    };
    clearInterval(qrTimer); await draw();
    qrTimer = setInterval(() => (tab() === 'whatsapp' ? draw() : clearInterval(qrTimer)), 20000);
  }

  /* ---------- boot ---------- */
  setInterval(() => { if (tab() === 'orders' && !$('#app').hidden) renderOrders(); }, 60000); // refresh "há X min"
  fetch('/api/admin/me').then((r) => (r.ok ? start() : showLogin())).catch(showLogin);
})();

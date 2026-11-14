(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const time = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const phoneFmt = (p) => {
    const d = String(p).replace(/^55/, '');
    return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : p;
  };

  let filter = 'all';
  let q = '';
  let statuses = [];
  let orders = [];
  let knownIds = null;
  let poll;

  function toast(m) {
    const t = $('#toast');
    t.textContent = m;
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('on'), 2200);
  }

  async function api(path, opts = {}) {
    const r = await fetch(path, opts);
    if (r.status === 401) { showLogin(); throw new Error('Sessão expirada'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Erro');
    return j;
  }
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  // ---------- auth ----------
  function showLogin() {
    clearInterval(poll);
    $('#appRoot').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#pw').focus();
  }
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    const r = await fetch('/api/admin/login', json('POST', { password: $('#pw').value }));
    if (!r.ok) return ($('#loginErr').textContent = (await r.json()).error);
    start();
  };
  $('#logout').onclick = async () => { await fetch('/api/admin/logout', { method: 'POST' }); showLogin(); };

  function start() {
    $('#login').classList.add('hidden');
    $('#appRoot').classList.remove('hidden');
    loadOrders();
    clearInterval(poll);
    poll = setInterval(() => document.visibilityState === 'visible' && currentTab() === 'orders' && loadOrders(), 5000);
  }

  // ---------- tabs ----------
  const currentTab = () => $('#tabs .on').dataset.tab;
  $('#tabs').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== b.dataset.tab));
    ({ orders: loadOrders, summary: loadSummary, products: loadProducts, settings: loadSettings, whatsapp: loadWa })[b.dataset.tab]();
  };

  // ---------- sound ----------
  let audioCtx;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.18, 0.36].forEach((t, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.frequency.value = [880, 1175, 1568][i];
        g.gain.setValueAtTime(0.2, audioCtx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.16);
        o.connect(g).connect(audioCtx.destination);
        o.start(audioCtx.currentTime + t);
        o.stop(audioCtx.currentTime + t + 0.17);
      });
      navigator.vibrate?.([120, 60, 120]);
    } catch {}
  }
  document.addEventListener('click', () => { if (!audioCtx) try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }, { once: true });

  // ---------- orders ----------
  async function loadOrders() {
    const j = await api(`/api/admin/orders`);
    statuses = j.statuses;
    const all = j.orders;
    const fresh = knownIds ? all.filter((o) => !knownIds.has(o.id)) : [];
    knownIds = new Set(all.map((o) => o.id));
    if (fresh.length) {
      beep();
      toast(`🔔 ${fresh.length === 1 ? 'Novo pedido #' + fresh[0].number_label : fresh.length + ' novos pedidos'}`);
      document.title = `(${fresh.length}) Novo pedido · Minionários`;
      setTimeout(() => (document.title = 'Painel · Minionários'), 8000);
    }
    orders = all;
    renderFilters(j.stats.byStatus, all.length);
    renderOrders(new Set(fresh.map((o) => o.id)));
  }

  function renderFilters(byStatus, total) {
    $('#filters').innerHTML =
      `<button data-f="all" class="${filter === 'all' ? 'on' : ''}">Todos<em>${total}</em></button>` +
      statuses.map((s) => `<button data-f="${s.key}" class="${filter === s.key ? 'on' : ''}">${s.emoji} ${esc(s.label)}<em>${byStatus[s.key] || 0}</em></button>`).join('');
  }
  $('#filters').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.f;
    $$('#filters button').forEach((x) => x.classList.toggle('on', x === b));
    renderOrders();
  };
  $('#q').oninput = (e) => { q = e.target.value.trim().toLowerCase(); renderOrders(); };

  function nextStatus(s) {
    const flow = statuses.filter((x) => x.key !== 'cancelado').map((x) => x.key);
    const i = flow.indexOf(s);
    return i >= 0 && i < flow.length - 1 ? statuses.find((x) => x.key === flow[i + 1]) : null;
  }

  function renderOrders(freshIds = new Set()) {
    const digits = q.replace(/\D/g, '');
    const list = orders.filter((o) => {
      if (filter !== 'all' && o.status !== filter) return false;
      if (!q) return true;
      return o.customer_name.toLowerCase().includes(q) || (digits && (o.phone.includes(digits) || o.number === +digits));
    });
    if (!list.length) return ($('#orders').innerHTML = `<p class="empty">Nenhum pedido ${filter !== 'all' ? 'neste status' : 'ainda'} 🍔</p>`);
    $('#orders').innerHTML = list.map((o) => {
      const nx = nextStatus(o.status);
      return `
      <article class="order ${o.status} ${freshIds.has(o.id) ? 'fresh' : ''}" data-id="${o.id}">
        <div class="o-head">
          <span class="o-num">#${o.number_label}</span>
          <span class="sp"></span>
          <span class="pill ${o.status}">${o.status_info.emoji} ${esc(o.status_info.label)}</span>
        </div>
        <div class="o-meta"><b>${esc(o.customer_name)}</b>
          <a href="https://wa.me/${esc(o.phone)}" target="_blank" rel="noopener">${esc(phoneFmt(o.phone))}</a> · ${time(o.created_at)}</div>
        <ul class="o-items">${o.items.map((l) => `<li><span>${l.qty}× ${esc(l.name)}</span><span class="muted">${brl(l.subtotal_cents)}</span></li>`).join('')}</ul>
        ${o.delivery_mode === 'entrega' ? `<div class="o-deliv">🛵 <b>Entrega · ${esc(o.bairro)}</b> — ${esc(o.address)}${o.address_ref ? ` (${esc(o.address_ref)})` : ''}<br><span class="muted">Taxa: ${o.delivery_fee_cents == null ? 'a combinar' : brl(o.delivery_fee_cents)}</span></div>` : `<div class="o-deliv pick">🏠 Retirada no local</div>`}
        ${o.notes ? `<div class="o-notes">📝 ${esc(o.notes)}</div>` : ''}
        <div class="o-foot">
          <span class="o-total">${brl(o.total_cents)}</span>
          <span class="badge ${o.source === 'whatsapp' ? 'wa' : ''}">${o.source === 'whatsapp' ? 'WhatsApp' : o.source === 'admin' ? 'Manual' : 'Site'}</span>
          <span class="sp"></span>
          ${o.has_receipt ? `<button class="btn sm light" data-receipt="${o.id}">🧾 Comprovante</button>` : `<span class="badge nr">sem comprovante</span>`}
        </div>
        <div class="o-actions">
          ${nx ? `<button class="btn sm" data-set="${o.id}:${nx.key}">${nx.emoji} ${esc(nx.label)}</button>` : `<span></span>`}
          <select data-sel="${o.id}" aria-label="Alterar status">
            ${statuses.map((s) => `<option value="${s.key}" ${s.key === o.status ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
          </select>
        </div>
      </article>`;
    }).join('');
  }

  async function setStatus(id, status) {
    if (status === 'cancelado' && !confirm('Cancelar este pedido?')) return renderOrders();
    try {
      const { order } = await api(`/api/admin/orders/${id}`, json('PATCH', { status }));
      const i = orders.findIndex((o) => o.id === order.id);
      orders[i] = order;
      toast(`#${order.number_label} → ${order.status_info.label}`);
      loadOrders();
    } catch (e) { toast(e.message); }
  }

  $('#orders').onclick = (e) => {
    const set = e.target.closest('[data-set]');
    if (set) { const [id, st] = set.dataset.set.split(':'); return setStatus(id, st); }
    const rc = e.target.closest('[data-receipt]');
    if (rc) return showReceipt(+rc.dataset.receipt);
  };
  $('#orders').onchange = (e) => {
    const sel = e.target.closest('[data-sel]');
    if (sel) setStatus(sel.dataset.sel, sel.value);
  };

  function modal(html) {
    $('#modalBody').innerHTML = html;
    $('#modal').showModal();
    $$('[data-close]', $('#modalBody')).forEach((b) => (b.onclick = () => $('#modal').close()));
  }
  $('#modal').onclick = (e) => { if (e.target === $('#modal')) $('#modal').close(); };

  function showReceipt(id) {
    const o = orders.find((x) => x.id === id);
    const url = `/api/admin/orders/${id}/receipt`;
    const nx = nextStatus(o.status);
    modal(`<div class="mhead"><h3>Comprovante · #${o.number_label} · ${brl(o.total_cents)}</h3><button class="iconbtn" data-close>×</button></div>
      <div class="receipt-view">${o.receipt_mime === 'application/pdf' ? `<iframe src="${url}"></iframe>` : `<a href="${url}" target="_blank"><img src="${url}" alt="Comprovante" /></a>`}</div>
      <p class="muted small">Confira valor (${brl(o.total_cents)}), data e recebedor antes de confirmar.</p>
      ${o.status === 'pedido_feito' ? `<button class="btn block green" id="confirmPay">💸 Confirmar pagamento</button>` : nx ? '' : ''}`);
    const b = $('#confirmPay');
    if (b) b.onclick = () => { $('#modal').close(); setStatus(id, 'pagamento_confirmado'); };
  }

  // Manual order
  $('#newOrder').onclick = async () => {
    const { products } = await api('/api/admin/products');
    const act = products.filter((p) => p.active);
    modal(`<div class="mhead"><h3>Pedido manual</h3><button class="iconbtn" data-close>×</button></div>
      <form id="mo">
        <div class="row2"><label class="field"><span>Nome</span><input class="input" name="customer_name" required /></label>
        <label class="field"><span>Telefone</span><input class="input" name="phone" type="tel" required /></label></div>
        ${act.map((p) => `<div class="line"><div class="nm">${esc(p.name)}<small>${brl(p.price_cents)}</small></div><input class="input" style="width:80px" type="number" min="0" max="50" value="0" data-pid="${p.id}" /></div>`).join('')}
        <label class="field" style="margin-top:12px"><span>Observações</span><input class="input" name="notes" /></label>
        <label class="field"><span>Status inicial</span><select class="input" name="status">${statuses.map((s) => `<option value="${s.key}">${esc(s.label)}</option>`).join('')}</select></label>
        <button class="btn block">Criar pedido</button><p class="err" id="moErr"></p>
      </form>`);
    $('#mo').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const items = $$('[data-pid]').map((i) => ({ product_id: +i.dataset.pid, qty: +i.value })).filter((i) => i.qty > 0);
      try {
        const { order } = await api('/api/admin/orders', json('POST', { customer_name: f.get('customer_name'), phone: f.get('phone'), notes: f.get('notes'), status: f.get('status'), items }));
        $('#modal').close();
        toast(`Pedido #${order.number_label} criado`);
        knownIds?.add(order.id);
        loadOrders();
      } catch (err) { $('#moErr').textContent = err.message; }
    };
  };

  // ---------- summary ----------
  async function loadSummary() {
    const { stats } = await api('/api/admin/orders');
    const t = stats.totals;
    const prods = Object.entries(stats.products).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...prods.map((p) => p[1]));
    const burgers = prods.reduce((s, [n, q]) => s + q * (/duplo/i.test(n) ? 2 : /papoiburg|combo/i.test(n) ? 1 : 0), 0);
    $('#summary').innerHTML = `
      <div class="stats">
        <div class="stat"><span>Pedidos (sem cancelados)</span><b>${t.orders}</b></div>
        <div class="stat"><span>Valor total</span><b>${brl(t.gross)}</b></div>
        <div class="stat"><span>Pagamentos confirmados</span><b>${brl(t.confirmed)}</b></div>
        <div class="stat"><span>Aguardando confirmação</span><b>${brl(t.gross - t.confirmed)}</b></div>
        <div class="stat"><span>Hambúrgueres a produzir*</span><b>${burgers}</b></div>
      </div>
      <div class="bars"><h3 style="margin-top:0">Itens vendidos</h3>
        ${prods.length ? prods.map(([n, qn]) => `<div class="bar"><span>${esc(n)}</span><i style="width:${(qn / max) * 100}%"></i><b>${qn}</b></div>`).join('') : '<p class="muted">Sem vendas ainda.</p>'}
        <p class="small muted">* Estimativa: Papoiburg e combos = 1 hambúrguer, Combo Minion Duplo = 2.</p>
      </div>`;
  }

  // ---------- products ----------
  let productsCache = [];
  async function loadProducts() {
    const { products } = await api('/api/admin/products');
    productsCache = products;
    $('#products').innerHTML = products.map((p) => `
      <div class="prod ${p.active ? '' : 'off'}">
        <div class="pic" style="${p.image_url ? `background-image:url('${p.image_url}')` : ''}">${p.image_url ? '' : esc(p.emoji)}</div>
        <div style="flex:1;min-width:0">
          <h3>${esc(p.name)} ${p.active ? '' : '<span class="badge nr">oculto</span>'} ${p.featured ? `<span class="badge wa">★ ${esc(p.badge || 'destaque')}</span>` : ''}</h3>
          <p>${esc(p.description)}</p>
          <p><b style="color:var(--ink)">${brl(p.price_cents)}</b> · ${esc(p.category)} · ordem ${p.sort}</p>
          <button class="btn sm light" data-edit="${p.id}">Editar</button>
        </div>
      </div>`).join('');
  }
  $('#products').onclick = (e) => { const b = e.target.closest('[data-edit]'); if (b) productForm(productsCache.find((p) => p.id === +b.dataset.edit)); };
  $('#addProduct').onclick = () => productForm(null);

  function productForm(p) {
    modal(`<div class="mhead"><h3>${p ? 'Editar item' : 'Novo item'}</h3><button class="iconbtn" data-close>×</button></div>
      <form id="pf">
        <label class="field"><span>Nome</span><input class="input" name="name" required value="${esc(p?.name || '')}" /></label>
        <label class="field"><span>Descrição</span><input class="input" name="description" value="${esc(p?.description || '')}" /></label>
        <div class="row2">
          <label class="field"><span>Preço (R$)</span><input class="input" name="price" inputmode="decimal" required value="${p ? (p.price_cents / 100).toFixed(2).replace('.', ',') : ''}" /></label>
          <label class="field"><span>Categoria</span><input class="input" name="category" value="${esc(p?.category || 'Combos')}" /></label>
          <label class="field"><span>Emoji (sem foto)</span><input class="input" name="emoji" value="${esc(p?.emoji || '🍔')}" /></label>
          <label class="field"><span>Ordem</span><input class="input" name="sort" type="number" value="${p?.sort ?? 99}" /></label>
        </div>
        <label class="field"><span>Foto</span><input class="input" type="file" name="image" accept="image/*" /></label>
        ${p?.image_url ? `<label class="switch"><input type="checkbox" name="remove_image" value="1" /> Remover foto atual</label>` : ''}
        <label class="switch"><input type="checkbox" name="active" ${!p || p.active ? 'checked' : ''} /> Visível no cardápio</label>
        <label class="switch"><input type="checkbox" name="featured" ${p?.featured ? 'checked' : ''} /> Mostrar em Destaques</label>
        <label class="field"><span>Selo do destaque (ex.: Mais completo)</span><input class="input" name="badge" maxlength="24" value="${esc(p?.badge || '')}" /></label>
        <button class="btn block">Salvar</button><p class="err" id="pfErr"></p>
      </form>`);
    $('#pf').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      fd.set('active', e.target.active.checked ? '1' : '0');
      fd.set('featured', e.target.featured.checked ? '1' : '0');
      if (!fd.get('image')?.size) fd.delete('image');
      try {
        await api(p ? `/api/admin/products/${p.id}` : '/api/admin/products', { method: p ? 'PUT' : 'POST', body: fd });
        $('#modal').close();
        toast('Cardápio atualizado');
        loadProducts();
      } catch (err) { $('#pfErr').textContent = err.message; }
    };
  }

  // ---------- settings ----------
  async function loadSettings() {
    const { settings: s } = await api('/api/admin/settings');
    const f = (k, label, extra = '') => `<label class="field"><span>${label}</span><input class="input" name="${k}" value="${esc(s[k])}" ${extra} /></label>`;
    const sw = (k, label) => `<label class="switch"><input type="checkbox" data-bool="${k}" ${s[k] === '1' ? 'checked' : ''} /> ${label}</label>`;
    $('#settingsForm').innerHTML = `
      <fieldset><legend>Vendas</legend>
        ${sw('accepting_orders', 'Pré-venda aberta (aceitando pedidos)')}
        ${sw('require_receipt', 'Exigir comprovante para enviar pedido pelo site')}
        ${sw('notify_status_whatsapp', 'Avisar o cliente no WhatsApp quando o status mudar')}
        ${sw('delivery_enabled', 'Oferecer entrega (taxa por bairro)')}
        ${f('delivery_note', 'Texto da entrega no topo do cardápio')}
        ${f('next_order_number', 'Próximo número de pedido', 'type="number" min="1" max="999"')}
      </fieldset>
      <fieldset><legend>Pix</legend>
        ${f('pix_key', 'Chave Pix')}
        <div class="row2">${f('pix_name', 'Nome do recebedor (até 25 letras)', 'maxlength="25"')}${f('pix_city', 'Cidade do recebedor', 'maxlength="15"')}</div>
        <p class="small muted">Telefone como chave: use o formato +55DDDNÚMERO (ex.: +5583987889174).</p>
      </fieldset>
      <fieldset><legend>Página</legend>
        <div class="row2">${f('team_name', 'Nome da equipe')}${f('instagram', 'Instagram (sem @)')}</div>
        ${f('tagline', 'Chamada')}${f('subtitle', 'Subtítulo')}
        <div class="row2">${f('event_date_label', 'Data')}${f('pickup_label', 'Retirada')}</div>
        <div class="row2">${f('pickup_address', 'Endereço de retirada')}${f('pickup_city', 'Cidade (para o mapa)')}</div>
        ${f('location_note', 'Aviso de local (usado se não houver endereço)')}
        ${f('whatsapp_number', 'WhatsApp da equipe (com 55)')}
        <div class="row2">
          <label class="field"><span>Foto de perfil</span><input class="input" type="file" name="avatar" accept="image/*" /></label>
          <label class="field"><span>Capa</span><input class="input" type="file" name="cover" accept="image/*" /></label>
        </div>
        <div style="display:flex;gap:12px">${s.avatar_url ? `<img src="${s.avatar_url}" style="width:64px;height:64px;border-radius:50%;object-fit:cover" />` : ''}${s.cover_url ? `<img src="${s.cover_url}" style="height:64px;border-radius:10px" />` : ''}</div>
      </fieldset>
      <button class="btn">Salvar configurações</button>`;
  }
  $('#settingsForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    $$('[data-bool]', e.target).forEach((c) => fd.set(c.dataset.bool, c.checked ? '1' : '0'));
    for (const k of ['avatar', 'cover']) if (!fd.get(k)?.size) fd.delete(k);
    try { await api('/api/admin/settings', { method: 'PUT', body: fd }); toast('Configurações salvas ✓'); loadSettings(); } catch (err) { toast(err.message); }
  };

  // ---------- whatsapp ----------
  let qrTimer;
  async function loadWa() {
    clearInterval(qrTimer);
    const w = await api('/api/admin/whatsapp');
    const labels = { open: 'Conectado', connecting: 'Aguardando leitura do QR Code', close: 'Desconectado', not_created: 'Instância ainda não criada', unknown: 'Desconhecido' };
    if (!w.configured) {
      $('#wa').innerHTML = `<fieldset><legend>WhatsApp (Evolution API)</legend><p>Defina as variáveis <code class="k">EVOLUTION_URL</code>, <code class="k">EVOLUTION_API_KEY</code> e <code class="k">PUBLIC_URL</code> no servidor para ativar o bot.</p></fieldset>`;
      return;
    }
    $('#wa').innerHTML = `
      <fieldset><legend>WhatsApp (Evolution API)</legend>
        <p><span class="status-dot ${w.state}"></span><b>${labels[w.state] || w.state}</b> · instância <code class="k">${esc(w.instance)}</code></p>
        ${w.error ? `<p class="err">${esc(w.error)}</p>` : ''}
        <p class="small muted">Webhook: <code class="k">${esc(w.webhook || '')}</code></p>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm" id="waSetup">${w.exists ? 'Reconfigurar webhook' : 'Criar instância'}</button>
          ${w.state !== 'open' && w.exists ? '<button class="btn sm yellow" id="waQr">Mostrar QR Code</button>' : ''}
          ${w.state === 'open' ? '<button class="btn sm danger" id="waOut">Desconectar</button>' : ''}
        </div>
        <div id="qrArea" style="margin-top:14px"></div>
      </fieldset>
      <fieldset><legend>Como o bot funciona</legend>
        <p class="small">O bot só responde a quem mandar mensagem para o número conectado. O cliente pode:</p>
        <ul class="small"><li><b>1</b> — fazer pedido pelo chat (escolhe itens por número, informa o nome, recebe QR Code + Pix copia e cola e envia o comprovante como foto ou PDF);</li>
        <li><b>2</b> ou <b>status</b> — consultar os pedidos feitos com o telefone dele (site ou WhatsApp);</li>
        <li><b>3</b> — receber o link do cardápio; <b>menu</b> volta ao início a qualquer momento.</li></ul>
      </fieldset>`;
    $('#waSetup').onclick = async () => { try { await api('/api/admin/whatsapp/setup', { method: 'POST' }); toast('Instância configurada'); loadWa(); } catch (e) { toast(e.message); } };
    const qrBtn = $('#waQr');
    if (qrBtn) qrBtn.onclick = showQr;
    const out = $('#waOut');
    if (out) out.onclick = async () => { if (confirm('Desconectar o WhatsApp?')) { await api('/api/admin/whatsapp/logout', { method: 'POST' }).catch((e) => toast(e.message)); loadWa(); } };
  }
  async function showQr() {
    const draw = async () => {
      try {
        const s = await api('/api/admin/whatsapp');
        if (s.state === 'open') { clearInterval(qrTimer); toast('WhatsApp conectado ✓'); return loadWa(); }
        const r = await api('/api/admin/whatsapp/qr');
        $('#qrArea').innerHTML = r.base64
          ? `<div class="qrbox"><img src="${r.base64}" alt="QR Code" /></div><p class="small muted">No celular da equipe: WhatsApp › Aparelhos conectados › Conectar aparelho. O QR atualiza sozinho.</p>${r.pairingCode ? `<p>Código de pareamento: <b>${esc(r.pairingCode)}</b></p>` : ''}`
          : '<p class="muted">Gerando QR Code…</p>';
      } catch (e) { $('#qrArea').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
    };
    clearInterval(qrTimer);
    await draw();
    qrTimer = setInterval(() => (currentTab() === 'whatsapp' ? draw() : clearInterval(qrTimer)), 20000);
  }

  // ---------- boot ----------
  fetch('/api/admin/me').then((r) => (r.ok ? start() : showLogin()));
})();

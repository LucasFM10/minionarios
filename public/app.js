/* Cardápio Minionários — mesma interface do artefato original, ligada à API (pedidos salvos, número #001, comprovante). */
(() => {
  const $ = (s) => document.querySelector(s);
  const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const BURGER_CATS = ['combos', 'hamburguer', 'hamburgueres', 'lanches'];
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const fmtKey = (k) => { const d = String(k).replace(/\D/g, ''); return /^\+?55\d{10,11}$/.test(String(k).replace(/[^\d+]/g, '')) && d.length >= 12 ? `(${d.slice(2, 4)}) ${d.slice(4, -4)}-${d.slice(-4)}` : k; };

  let S = {}, PRODUCTS = [], CATS = [];
  const byId = (id) => PRODUCTS.find((p) => p.id === +id);
  let bag = store.get('mn_bag2', {});
  let cliente = Object.assign({ nome: '', tel: '', obs: '', modo: '', bairro: '', rua: '', ref: '' }, store.get('mn_cliente2', {}));
  let pedido = null, sending = false, waSent = true, closeWarned = false;
  const hasBurger = () => Object.keys(bag).some((k) => byId(k) && BURGER_CATS.includes(norm(byId(k).category)));

  const bagCount = () => Object.values(bag).reduce((a, b) => a + b, 0);
  const bagTotal = () => Object.entries(bag).reduce((a, [k, q]) => a + byId(k).price_cents * q, 0);
  function saveBag() { store.set('mn_bag2', bag); renderBagBar(); renderBadges(); }
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 1800); }
  const phHtml = (p, alt = '') => (p.image ? `<img src="${esc(p.image)}" alt="${esc(alt)}" loading="lazy">` : `<span class="emo">${esc(p.emoji)}</span>`);

  /* ===== loja ===== */
  async function load() {
    const r = await fetch('/api/menu').then((r) => r.json());
    S = r.settings; PRODUCTS = r.products;
    for (const k in bag) if (!byId(k) || !(bag[k] > 0)) delete bag[k];
    renderStore(); renderMenu(); renderBagBar(); renderMyOrders();
  }

  function renderStore() {
    document.title = `${S.team_name} Burger`;
    $('#teamName').textContent = S.team_name;
    $('#sub').textContent = [S.tagline, S.subtitle].filter(Boolean).join(' ');
    $('#chipDate').textContent = S.event_date_label;
    $('#chipPickup').textContent = S.pickup_label;
    if (S.avatar_image) $('#avatarImg').src = S.avatar_image;
    if (S.cover_image) $('#coverImg').src = S.cover_image;
    const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${S.pickup_address}, ${S.pickup_city || ''}`)}`;
    let html = S.pickup_address
      ? `<b>Retirada:</b> ${esc(S.pickup_address)} · <a href="${maps}" target="_blank" rel="noopener">ver no mapa</a>`
      : `<b>Retirada:</b> ${esc(S.location_note)}`;
    if (S.delivery_enabled) html += `<br><b>Entrega:</b> ${esc(S.delivery_note)}`;
    $('#noteText').innerHTML = html;
    $('#closed').hidden = S.accepting_orders;
  }

  function renderMyOrders() {
    const mine = store.get('mn_orders', []);
    const el = $('#myOrders');
    el.hidden = !mine.length;
    if (mine.length) el.innerHTML = `Seus pedidos: ${mine.slice(0, 4).map((o) => `<a href="/pedido?c=${encodeURIComponent(o.code)}">#${esc(o.number)}</a>`).join(' · ')}`;
  }

  /* ===== cardápio ===== */
  function renderMenu() {
    const tabs = $('#tabs'), menu = $('#menu');
    const featured = PRODUCTS.filter((p) => p.featured);
    const cats = [...new Set(PRODUCTS.map((p) => p.category))];
    CATS = [...(featured.length ? [{ id: 'destaques', nome: 'Destaques' }] : []), ...cats.map((c, i) => ({ id: 'cat' + i, nome: c }))];
    tabs.innerHTML = CATS.map((c, i) => `<button class="tab" type="button" data-go="${c.id}" aria-current="${i === 0}">${esc(c.nome)}</button>`).join('');
    let html = '';
    if (featured.length) {
      html += `<section id="destaques"><h2 class="sec-h">Destaques</h2><div class="hl">` +
        featured.map((p) => `<button class="hcard" type="button" data-p="${p.id}"><div class="ph">${phHtml(p)}${p.badge ? `<span class="badge">${esc(p.badge)}</span>` : ''}<span class="qtyb" data-q="${p.id}" hidden></span></div><span class="price">${brl(p.price_cents)}</span><span class="nm">${esc(p.name)}</span></button>`).join('') +
        `</div></section>`;
    }
    cats.forEach((c, i) => {
      const items = PRODUCTS.filter((p) => p.category === c);
      html += `<section id="cat${i}"><h2 class="sec-h">${esc(c)}</h2><div class="list">` +
        items.map((p) => `<button class="item" type="button" data-p="${p.id}"><div class="tx"><span class="nm">${esc(p.name)}</span><span class="ds">${esc(p.description)}</span><span class="price">${brl(p.price_cents)}</span></div><div class="ph">${phHtml(p)}<span class="qtyb" data-q="${p.id}" hidden></span></div></button>`).join('') +
        `</div></section>`;
    });
    menu.innerHTML = html;
    menu.onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) openProduct(b.dataset.p); };
    tabs.onclick = (e) => { const b = e.target.closest('[data-go]'); if (!b) return; document.getElementById(b.dataset.go).scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); };
    const secs = [...menu.querySelectorAll('section')];
    const io = new IntersectionObserver((ents) => {
      const vis = ents.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!vis) return;
      tabs.querySelectorAll('.tab').forEach((t) => { const on = t.dataset.go === vis.target.id; t.setAttribute('aria-current', on); if (on) t.scrollIntoView({ block: 'nearest', inline: 'center' }); });
    }, { rootMargin: '-80px 0px -60% 0px' });
    secs.forEach((s) => io.observe(s));
    renderBadges();
  }
  function renderBadges() { document.querySelectorAll('[data-q]').forEach((el) => { const q = bag[el.dataset.q] || 0; el.hidden = !q; el.textContent = q + '×'; }); }
  function renderBagBar() { const n = bagCount(); $('#bagbar').hidden = !n || !S.accepting_orders; $('#bagN').textContent = n; $('#bagT').textContent = brl(bagTotal()); }

  /* ===== folha ===== */
  let view = null, history_ = [];
  function openSheet(v) { if (view === null) { $('#scrim').hidden = false; $('#sheet').hidden = false; requestAnimationFrame(() => { $('#scrim').classList.add('on'); $('#sheet').classList.add('on'); }); } else history_.push(view); show(v); }
  function closeSheet() {
    if (view === DoneView && !waSent && !closeWarned) { closeWarned = true; const a = $('#waAlert'); if (a) { a.classList.remove('nudge'); void a.offsetWidth; a.classList.add('nudge'); a.scrollIntoView({ block: 'center' }); } toast('Conclua o pedido no WhatsApp antes de sair'); return; }
    $('#scrim').classList.remove('on'); $('#sheet').classList.remove('on');
    setTimeout(() => { $('#scrim').hidden = true; $('#sheet').hidden = true; }, 220);
    if (view === DoneView) { renderMyOrders(); }
    view = null; history_ = [];
  }
  function back() { const prev = history_.pop(); if (prev) show(prev); else closeSheet(); }
  function show(v) { view = v; $('#shBody').scrollTop = 0; $('#shBody').onclick = null; v.render(); $('#shBack').style.visibility = history_.length && v !== DoneView ? 'visible' : 'hidden'; }
  $('#scrim').onclick = closeSheet; $('#shClose').onclick = closeSheet; $('#shBack').onclick = back;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && view) closeSheet(); });
  $('#openBag').onclick = () => openSheet(BagView);

  /* produto */
  function openProduct(id) {
    const p = byId(id); let q = 1;
    const PV = { render() {
      $('#shTitle').textContent = '';
      $('#shBody').innerHTML = `<div class="p-img">${phHtml(p, p.name)}</div><h3 class="p-name">${esc(p.name)}</h3><p class="p-desc">${esc(p.description)}</p><div class="p-price price">${brl(p.price_cents)}</div>`;
      if (!S.accepting_orders) { $('#shFoot').innerHTML = `<p class="center" style="color:var(--muted);margin:0">Pré-venda encerrada.</p>`; return; }
      const draw = () => {
        $('#shFoot').innerHTML = `<div class="row"><div class="stepper"><button type="button" id="qm" aria-label="Menos">−</button><output id="qv">${q}</output><button type="button" id="qp" aria-label="Mais">+</button></div><button class="cta" type="button" id="add" style="flex:1"><span>Adicionar</span><span class="price">${brl(p.price_cents * q)}</span></button></div>`;
        $('#qm').onclick = () => { if (q > 1) { q--; draw(); } }; $('#qp').onclick = () => { if (q < 20) { q++; draw(); } };
        $('#add').onclick = () => { bag[p.id] = Math.min(50, (bag[p.id] || 0) + q); saveBag(); closeSheet(); toast(`${q}× ${p.name} na sacola`); };
      };
      draw();
    } };
    openSheet(PV);
  }

  /* sacola */
  const trash = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>`;
  const BagView = { render() {
    $('#shTitle').textContent = 'Sacola';
    const ents = Object.entries(bag);
    if (!ents.length) { $('#shBody').innerHTML = `<p class="empty">Sua sacola está vazia.</p>`; $('#shFoot').innerHTML = `<button class="cta dark" type="button" id="keep"><span>Ver cardápio</span><span></span></button>`; $('#keep').onclick = closeSheet; return; }
    $('#shBody').innerHTML = ents.map(([k, q]) => { const p = byId(k); return `<div class="bag-item">${p.image ? `<img src="${esc(p.image)}" alt="">` : `<span class="bph">${esc(p.emoji)}</span>`}<div class="nm">${esc(p.name)}<div class="price" style="font-weight:600;color:var(--muted);font-size:13.5px">${brl(p.price_cents * q)}</div></div><div class="stepper sm"><button type="button" data-m="${k}" aria-label="Menos ${esc(p.name)}">${q === 1 ? trash : '−'}</button><output>${q}</output><button type="button" data-a="${k}" aria-label="Mais ${esc(p.name)}">+</button></div></div>`; }).join('')
      + `<button class="ghost" type="button" id="more">+ Adicionar mais itens</button><div class="sum"><span>Total</span><span class="price">${brl(bagTotal())}</span></div>`;
    $('#shBody').onclick = (e) => {
      const m = e.target.closest('[data-m]'), a = e.target.closest('[data-a]');
      if (m) { const k = m.dataset.m; bag[k]--; if (bag[k] <= 0) delete bag[k]; saveBag(); BagView.render(); }
      if (a) { const k = a.dataset.a; if (bag[k] < 20) bag[k]++; saveBag(); BagView.render(); }
      if (e.target.id === 'more') closeSheet();
    };
    $('#shFoot').innerHTML = `<button class="cta" type="button" id="go"><span>Continuar</span><span class="price">${brl(bagTotal())}</span></button>`;
    $('#go').onclick = () => openSheet(FormView);
  } };

  /* dados do cliente */
  function maskTel(v) { const d = v.replace(/\D/g, '').slice(0, 11); if (d.length <= 2) return d.length ? `(${d}` : ''; if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`; if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`; return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`; }
  const FormView = { render() {
    $('#shTitle').textContent = 'Seus dados';
    const podeEntregar = S.delivery_enabled && hasBurger();
    if (!podeEntregar && cliente.modo === 'entrega') cliente.modo = '';
    if (!S.delivery_enabled) cliente.modo = 'retirada';
    const pickupTxt = S.pickup_address ? `Sem taxa. ${esc(S.pickup_address)}${S.pickup_city ? ', ' + esc(S.pickup_city.replace(/\s*-\s*PB$/, '')) : ''}.` : `Sem taxa. ${esc(S.location_note)}`;
    $('#shBody').innerHTML = `<form id="f" novalidate>
      <div class="field"><label for="nome">Nome completo</label><input id="nome" autocomplete="name" value="${esc(cliente.nome)}" placeholder="Seu nome"><span class="err" id="eNome" hidden>Digite seu nome.</span></div>
      <div class="field"><label for="tel">Telefone (WhatsApp)</label><input id="tel" type="tel" inputmode="numeric" autocomplete="tel" value="${esc(cliente.tel)}" placeholder="(83) 9 0000-0000"><span class="err" id="eTel" hidden>Digite um telefone com DDD.</span></div>
      <div class="field"${S.delivery_enabled ? '' : ' hidden'}><span class="legend" id="lgModo">Como você quer receber?</span>
        <div class="opts" role="radiogroup" aria-labelledby="lgModo">
          <label class="opt"><input type="radio" name="modo" value="retirada" ${cliente.modo === 'retirada' ? 'checked' : ''}><div><b>Retirar no local</b><span>${pickupTxt}</span></div></label>
          <label class="opt${podeEntregar ? '' : ' off'}"><input type="radio" name="modo" value="entrega" ${cliente.modo === 'entrega' ? 'checked' : ''} ${podeEntregar ? '' : 'disabled'}><div><b>Receber em casa</b><span>${podeEntregar ? 'Entrega em João Pessoa na noite do evento. A taxa é calculada pela distância.' : 'A entrega vale só para pedidos com pelo menos um hambúrguer ou combo.'}</span></div></label>
        </div><span class="err" id="eModo" hidden>Escolha retirar no local ou receber em casa.</span></div>
      <div id="addr" hidden>
        <div class="field"><label for="cep">CEP <span style="font-weight:400;color:var(--muted)">(opcional — preenche a rua)</span></label><input id="cep" inputmode="numeric" autocomplete="postal-code" value="${esc(cliente.cep || '')}" placeholder="00000-000"><span class="err" id="eCep" hidden></span></div>
        <div class="field"><label for="rua">Rua e número</label><input id="rua" autocomplete="street-address" value="${esc(cliente.rua)}" placeholder="Ex.: Rua Golfo de Lion, 120"><span class="err" id="eRua" hidden>Digite a rua e o número.</span></div>
        <div class="field"><label for="bairro">Bairro</label><input id="bairro" value="${esc(cliente.bairro)}" placeholder="Ex.: Manaíra"><span class="err" id="eBairro" hidden>Digite o seu bairro.</span><div id="taxaBox" hidden></div></div>
        <div class="field"><label for="ref">Complemento e ponto de referência</label><input id="ref" value="${esc(cliente.ref)}" placeholder="Ex.: apto 302, perto da padaria"></div>
      </div>
      <div class="field"><span class="legend">Pagamento</span>
        <div class="opts">
          <div class="opt" style="border-color:var(--ink);background:var(--yellow-soft);cursor:default"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="margin-top:2px"><path d="M5 12l5 5 9-10"/></svg><div><b>Pix antecipado</b><span>A reserva é feita com pagamento antecipado por Pix. O QR Code e o Pix copia e cola chegam no WhatsApp da equipe.</span></div></div>
        </div></div>
      <div class="field"><label for="obs">Observação (opcional)</label><textarea id="obs" placeholder="Ex.: sem cebola">${esc(cliente.obs)}</textarea></div>
      <p class="err" id="eApi" hidden></p>
    </form>`;
    const tel = $('#tel'); tel.oninput = () => { tel.value = maskTel(tel.value); }; if (tel.value) tel.value = maskTel(tel.value);
    const modo = () => (document.querySelector('input[name=modo]:checked') || {}).value || (S.delivery_enabled ? '' : 'retirada');
    let quote = null, qTimer = null, qSeq = 0;
    const taxaAtual = () => (modo() !== 'entrega' ? 0 : quote && quote.fee_cents != null ? quote.fee_cents : undefined);
    const paint = () => {
      const m = modo(); $('#addr').hidden = m !== 'entrega';
      const box = $('#taxaBox');
      if (m === 'entrega' && quote) {
        box.hidden = false;
        if (quote.loading) { box.className = 'taxa'; box.innerHTML = '<span>Calculando a taxa de entrega…</span>'; }
        else if (quote.too_far) { box.className = 'taxa far'; box.innerHTML = `<b>Esse endereço fica a ≈ ${String(quote.km).replace('.', ',')} km — só entregamos até ${String(quote.max_km).replace('.', ',')} km.</b> Escolha a retirada no local ou confira o endereço.`; }
        else if (quote.fee_cents != null) { box.className = 'taxa'; box.innerHTML = `<span>Taxa de entrega${quote.km ? ` · ≈ ${String(quote.km).replace('.', ',')} km` : ''}</span><b class="price">${brl(quote.fee_cents)}</b>`; }
        else { box.className = 'taxa far'; box.innerHTML = '<b>Não encontramos esse endereço no mapa.</b> Confira a rua e o bairro (ou informe o CEP). Se continuar assim, pode seguir: a taxa de entrega é combinada com a equipe no WhatsApp.'; }
      } else box.hidden = true;
      const t = taxaAtual();
      $('#nextT').textContent = brl(bagTotal() + (typeof t === 'number' ? t : 0));
    };
    const requote = () => {
      clearTimeout(qTimer);
      if (modo() !== 'entrega') { quote = null; return paint(); }
      const rua = $('#rua').value.trim(), bairro = $('#bairro').value.trim(), cepV = $('#cep').value.replace(/\D/g, '');
      if (rua.length < 4 || (!bairro && cepV.length !== 8)) { quote = null; return paint(); }
      quote = { loading: true }; paint();
      const my = ++qSeq;
      qTimer = setTimeout(async () => {
        try {
          const r = await fetch('/api/delivery/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: rua, bairro, cep: cepV }) }).then((r) => r.json());
          if (my === qSeq) { quote = { fee_cents: r.fee_cents ?? null, km: r.km, too_far: !!r.too_far, max_km: r.max_km }; paint(); }
        } catch { if (my === qSeq) { quote = { fee_cents: null }; paint(); } }
      }, 700);
    };
    const refresh = () => { paint(); requote(); };
    $('#shFoot').innerHTML = `<button class="cta dark" type="button" id="next"><span>Fechar pedido</span><span class="price" id="nextT">${brl(bagTotal())}</span></button>`;
    $('#f').addEventListener('change', refresh); $('#f').addEventListener('input', (e) => { if (['rua', 'bairro'].includes(e.target.id)) requote(); }); refresh();
    const cep = $('#cep');
    cep.oninput = async () => {
      let d = cep.value.replace(/\D/g, '').slice(0, 8);
      cep.value = d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
      $('#eCep').hidden = true;
      if (d.length !== 8) return;
      try {
        const r = await fetch(`https://viacep.com.br/ws/${d}/json/`).then((r) => r.json());
        if (r.erro) throw new Error('CEP não encontrado. Digite a rua manualmente.');
        if (r.logradouro) { $('#rua').value = `${r.logradouro}, `; $('#rua').focus(); }
        if (r.bairro) $('#bairro').value = r.bairro;
        requote();
      } catch (e) { const el = $('#eCep'); el.hidden = false; el.style.color = ''; el.textContent = e.message.includes('CEP') ? e.message : 'Não foi possível consultar o CEP. Digite a rua manualmente.'; }
    };
    $('#next').onclick = async () => {
      const nome = $('#nome').value.trim(), t = $('#tel').value, d = t.replace(/\D/g, ''), m = modo(), obs = $('#obs').value.trim();
      const bairro = $('#bairro').value, rua = $('#rua').value.trim(), ref = $('#ref').value.trim();
      $('#eNome').hidden = nome.length >= 2; $('#eTel').hidden = d.length >= 10; $('#eModo').hidden = !!m;
      const ent = m === 'entrega'; $('#eBairro').hidden = true; $('#eRua').hidden = !ent || rua.length >= 4;
      if (nome.length < 2) { $('#nome').focus(); return; } if (d.length < 10) { $('#tel').focus(); return; }
      if (!m) { $('#eModo').scrollIntoView({ block: 'center' }); return; }
      if (ent && rua.length < 4) { $('#rua').focus(); return; }
      if (ent && quote && quote.too_far) { $('#taxaBox').scrollIntoView({ block: 'center' }); return; }
      const cepV = ent ? $('#cep').value.trim() : '';
      cliente = { nome, tel: t, obs, modo: m, bairro: ent ? bairro : '', rua: ent ? rua : '', ref: ent ? ref : '', cep: cepV }; store.set('mn_cliente2', cliente);
      const items = Object.entries(bag).map(([k, q]) => ({ product_id: +k, qty: q }));
      const delivery = ent ? { mode: 'entrega', bairro, address: rua, cep: cepV.replace(/\D/g, ''), ref } : { mode: 'retirada' };
      pedido = { items, delivery };
      createOrder();
    };
  } };

  /* concluir no WhatsApp */
  const WA_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.5-1.1-2.9s.7-2.1 1-2.4c.3-.3.6-.3.8-.3h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.6-.1l2 1c.3.1.5.2.5.3.1.1.1.6-.1 1.2z"/></svg>`;
  async function createOrder() {
    if (sending) return; sending = true;
    const btn = $('#next'); btn.disabled = true; btn.firstElementChild.textContent = 'Gerando pedido…';
    try {
      const fd = new FormData();
      fd.append('name', cliente.nome); fd.append('phone', cliente.tel); fd.append('notes', cliente.obs);
      fd.append('items', JSON.stringify(pedido.items)); fd.append('delivery', JSON.stringify(pedido.delivery));
      const r = await fetch('/api/orders', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      pedido.order = j.order; waSent = false; closeWarned = false;
      const mine = store.get('mn_orders', []); mine.unshift({ code: j.order.code, number: j.order.number }); store.set('mn_orders', mine.slice(0, 20));
      bag = {}; saveBag();
      history_ = []; show(DoneView);
    } catch (e) {
      const el = $('#eApi'); el.hidden = false; el.textContent = e.message || 'Não foi possível gerar o pedido. Tente novamente.';
      btn.disabled = false; btn.firstElementChild.textContent = 'Fechar pedido';
    } finally { sending = false; }
  }
  const waText = (o) => `Olá! Quero confirmar meu *pedido #${o.number}* da ${S.team_name} 🍔\nValor: *${brl(o.total_cents)}*\nRef: ${o.ref}`;
  const DoneView = { render() {
    const o = pedido.order, ent = o.delivery_mode === 'entrega';
    $('#shTitle').textContent = 'Último passo';
    const url = `https://wa.me/${S.whatsapp_number}?text=${encodeURIComponent(waText(o))}`;
    $('#shBody').innerHTML = `<div class="alert" id="waAlert" style="margin-top:4px"><b class="h">Falta concluir no WhatsApp!</b>Seu pedido foi gerado, mas só é <b>confirmado no WhatsApp</b>. Toque no botão verde e envie a mensagem que já vai pronta.</div>
      <p class="center" style="margin:16px 0 0;color:var(--muted)">Número do pedido</p><p class="center code big" style="margin:0">#${esc(o.number)}</p>
      <dl class="lines"><dt>Itens</dt><dd>${brl(o.subtotal_cents)}</dd>${ent ? `<dt>Entrega${o.bairro ? ' · ' + esc(o.bairro) : ''}${o.delivery_km ? ' · ≈ ' + String(o.delivery_km).replace('.', ',') + ' km' : ''}</dt><dd>${o.delivery_fee_cents === null ? 'a combinar' : brl(o.delivery_fee_cents)}</dd>` : `<dt>Retirada no local</dt><dd>grátis</dd>`}<dt class="tot">Total no Pix</dt><dd class="tot">${brl(o.total_cents)}</dd></dl>
      <ol class="steps"><li>Toque em <b>Concluir pedido no WhatsApp</b> e envie a mensagem com o número do pedido.</li><li>Você recebe na conversa o <b>QR Code e o Pix copia e cola</b> com o valor.</li><li>Pague e <b>anexe o comprovante do Pix</b> na mesma conversa. Pronto!</li></ol>
      <p class="cause" style="text-align:center">Acompanhe o status pelo WhatsApp ou pelo link <a href="/pedido?c=${encodeURIComponent(o.code)}">Acompanhar pedido</a>.</p>`;
    $('#shFoot').innerHTML = `<a class="cta wa" id="wa" href="${url}" target="_blank" rel="noopener">${WA_ICON}<span>Concluir pedido no WhatsApp</span></a>
      <a class="ghost" href="/pedido?c=${encodeURIComponent(o.code)}">Acompanhar pedido #${esc(o.number)}</a>`;
    $('#wa').addEventListener('click', () => { waSent = true; });
  } };

  load().catch(() => { $('#menu').innerHTML = '<p class="empty">Não foi possível carregar o cardápio. Recarregue a página.</p>'; });
})();

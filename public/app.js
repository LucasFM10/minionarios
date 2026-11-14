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

  let S = {}, PRODUCTS = [], BAIRROS = [], CATS = [];
  const byId = (id) => PRODUCTS.find((p) => p.id === +id);
  let bag = store.get('mn_bag2', {});
  let cliente = Object.assign({ nome: '', tel: '', obs: '', modo: '', bairro: '', rua: '', ref: '' }, store.get('mn_cliente2', {}));
  let pedido = null, pix = null, receipt = null, sending = false;
  const hasBurger = () => Object.keys(bag).some((k) => byId(k) && BURGER_CATS.includes(norm(byId(k).category)));
  const findBairro = (n) => BAIRROS.find((b) => b.n === n);

  const bagCount = () => Object.values(bag).reduce((a, b) => a + b, 0);
  const bagTotal = () => Object.entries(bag).reduce((a, [k, q]) => a + byId(k).price_cents * q, 0);
  function saveBag() { store.set('mn_bag2', bag); renderBagBar(); renderBadges(); }
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 1800); }
  const phHtml = (p, alt = '') => (p.image ? `<img src="${esc(p.image)}" alt="${esc(alt)}" loading="lazy">` : `<span class="emo">${esc(p.emoji)}</span>`);

  /* ===== loja ===== */
  async function load() {
    const r = await fetch('/api/menu').then((r) => r.json());
    S = r.settings; PRODUCTS = r.products; BAIRROS = r.bairros || [];
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
    const opts = BAIRROS.map((b) => `<option value="${esc(b.n)}" ${cliente.bairro === b.n ? 'selected' : ''}>${esc(b.n)}</option>`).join('');
    const pickupTxt = S.pickup_address ? `Sem taxa. ${esc(S.pickup_address)}${S.pickup_city ? ', ' + esc(S.pickup_city.replace(/\s*-\s*PB$/, '')) : ''}.` : `Sem taxa. ${esc(S.location_note)}`;
    $('#shBody').innerHTML = `<form id="f" novalidate>
      <div class="field"><label for="nome">Nome completo</label><input id="nome" autocomplete="name" value="${esc(cliente.nome)}" placeholder="Seu nome"><span class="err" id="eNome" hidden>Digite seu nome.</span></div>
      <div class="field"><label for="tel">Telefone (WhatsApp)</label><input id="tel" type="tel" inputmode="numeric" autocomplete="tel" value="${esc(cliente.tel)}" placeholder="(83) 9 0000-0000"><span class="err" id="eTel" hidden>Digite um telefone com DDD.</span></div>
      <div class="field"${S.delivery_enabled ? '' : ' hidden'}><span class="legend" id="lgModo">Como você quer receber?</span>
        <div class="opts" role="radiogroup" aria-labelledby="lgModo">
          <label class="opt"><input type="radio" name="modo" value="retirada" ${cliente.modo === 'retirada' ? 'checked' : ''}><div><b>Retirar no local</b><span>${pickupTxt}</span></div></label>
          <label class="opt${podeEntregar ? '' : ' off'}"><input type="radio" name="modo" value="entrega" ${cliente.modo === 'entrega' ? 'checked' : ''} ${podeEntregar ? '' : 'disabled'}><div><b>Receber em casa</b><span>${podeEntregar ? 'Entrega em João Pessoa na noite do evento. A taxa depende do bairro.' : 'A entrega vale só para pedidos com pelo menos um hambúrguer ou combo.'}</span></div></label>
        </div><span class="err" id="eModo" hidden>Escolha retirar no local ou receber em casa.</span></div>
      <div id="addr" hidden>
        <div class="field"><label for="bairro">Bairro</label><select id="bairro"><option value="">Selecione seu bairro</option>${opts}</select><span class="err" id="eBairro" hidden>Selecione o seu bairro.</span><div id="taxaBox" hidden></div></div>
        <div class="field"><label for="rua">Rua e número</label><input id="rua" autocomplete="street-address" value="${esc(cliente.rua)}" placeholder="Ex.: Rua Golfo de Lion, 120"><span class="err" id="eRua" hidden>Digite a rua e o número.</span></div>
        <div class="field"><label for="ref">Complemento e ponto de referência</label><input id="ref" value="${esc(cliente.ref)}" placeholder="Ex.: apto 302, perto da padaria"></div>
      </div>
      <div class="field"><span class="legend">Pagamento</span>
        <div class="opts">
          <div class="opt" style="border-color:var(--ink);background:var(--yellow-soft);cursor:default"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="margin-top:2px"><path d="M5 12l5 5 9-10"/></svg><div><b>Pix antecipado</b><span>A reserva é feita com pagamento antecipado por Pix. Na próxima tela você vê o QR Code e o Pix copia e cola.</span></div></div>
        </div></div>
      <div class="field"><label for="obs">Observação (opcional)</label><textarea id="obs" placeholder="Ex.: sem cebola">${esc(cliente.obs)}</textarea></div>
      <p class="err" id="eApi" hidden></p>
    </form>`;
    const tel = $('#tel'); tel.oninput = () => { tel.value = maskTel(tel.value); }; if (tel.value) tel.value = maskTel(tel.value);
    const modo = () => (document.querySelector('input[name=modo]:checked') || {}).value || (S.delivery_enabled ? '' : 'retirada');
    const taxaAtual = () => { if (modo() !== 'entrega') return 0; const b = findBairro($('#bairro').value); return b ? b.fee : undefined; };
    const refresh = () => {
      const m = modo(); $('#addr').hidden = m !== 'entrega';
      const b = findBairro($('#bairro').value), box = $('#taxaBox');
      if (m === 'entrega' && b) { box.hidden = false; box.className = b.fee ? 'taxa' : 'taxa far'; box.innerHTML = b.fee ? `<span>Taxa de entrega para ${esc(b.n)}</span><b class="price">${brl(b.fee)}</b>` : `<b>${esc(b.n)} fica a mais de 5 km.</b> Você paga o pedido pelo Pix agora, e a taxa de entrega é combinada com a equipe no WhatsApp.`; } else box.hidden = true;
      const t = taxaAtual();
      $('#nextT').textContent = brl(bagTotal() + (typeof t === 'number' ? t : 0));
    };
    $('#shFoot').innerHTML = `<button class="cta dark" type="button" id="next"><span>Continuar</span><span class="price" id="nextT">${brl(bagTotal())}</span></button>`;
    $('#f').addEventListener('change', refresh); refresh();
    $('#next').onclick = async () => {
      const nome = $('#nome').value.trim(), t = $('#tel').value, d = t.replace(/\D/g, ''), m = modo(), obs = $('#obs').value.trim();
      const bairro = $('#bairro').value, rua = $('#rua').value.trim(), ref = $('#ref').value.trim();
      $('#eNome').hidden = nome.length >= 2; $('#eTel').hidden = d.length >= 10; $('#eModo').hidden = !!m;
      const ent = m === 'entrega'; $('#eBairro').hidden = !ent || !!bairro; $('#eRua').hidden = !ent || rua.length >= 4;
      if (nome.length < 2) { $('#nome').focus(); return; } if (d.length < 10) { $('#tel').focus(); return; }
      if (!m) { $('#eModo').scrollIntoView({ block: 'center' }); return; }
      if (ent && !bairro) { $('#bairro').focus(); return; } if (ent && rua.length < 4) { $('#rua').focus(); return; }
      cliente = { nome, tel: t, obs, modo: m, bairro: ent ? bairro : '', rua: ent ? rua : '', ref: ent ? ref : '' }; store.set('mn_cliente2', cliente);
      const items = Object.entries(bag).map(([k, q]) => ({ product_id: +k, qty: q }));
      const delivery = ent ? { mode: 'entrega', bairro, address: rua, ref } : { mode: 'retirada' };
      const btn = $('#next'); btn.disabled = true;
      try {
        const r = await fetch('/api/pix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, delivery }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        pix = j; pedido = { items, delivery, itens: Object.entries(bag).map(([k, q]) => ({ p: byId(k), q })) }; receipt = null;
        openSheet(PixView);
      } catch (e) { const el = $('#eApi'); el.hidden = false; el.textContent = e.message || 'Erro ao gerar o Pix. Tente novamente.'; btn.disabled = false; }
    };
  } };

  /* pix */
  async function copyText(txt, okMsg) {
    try { await navigator.clipboard.writeText(txt); toast(okMsg); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = txt; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (_) {} ta.remove(); toast(ok ? okMsg : 'Segure no código para copiar'); }
  }
  function linesHtml() {
    const ent = pix.delivery.mode === 'entrega';
    return `<dl class="lines"><dt>Itens</dt><dd>${brl(pix.subtotal_cents)}</dd>${ent ? `<dt>Entrega · ${esc(pix.delivery.bairro)}</dt><dd>${pix.fee_cents === null ? 'a combinar' : brl(pix.fee_cents)}</dd>` : `<dt>Retirada no local</dt><dd>grátis</dd>`}<dt class="tot">Total no Pix</dt><dd class="tot">${brl(pix.total_cents)}</dd></dl>`;
  }
  const PixView = { render() {
    $('#shTitle').textContent = 'Pagamento via Pix';
    $('#shBody').innerHTML = `<p class="pix-total">Valor a pagar <span class="price">${brl(pix.total_cents)}</span></p>
      ${linesHtml()}
      <div class="qr" aria-label="QR Code Pix"><img src="${pix.qr}" alt="QR Code Pix"></div>
      <p class="center" style="color:var(--muted);font-size:13px;margin:0">O valor já vem preenchido no QR Code e no copia e cola.</p>
      <div class="field"><span class="legend">Pix copia e cola</span><div class="copybox"><code>${esc(pix.payload)}</code><button class="copybtn" type="button" id="cpCode">Copiar</button></div></div>
      <dl class="kv"><dt>Recebedor</dt><dd>${esc(S.pix_name)}</dd><dt>Chave (celular)</dt><dd>${esc(fmtKey(S.pix_key))} <button class="copybtn" type="button" id="cpKey" style="padding:4px 8px;margin-left:4px">Copiar</button></dd></dl>
      <ol class="steps"><li>Abra o app do seu banco e pague com o QR Code ou com o Pix copia e cola.</li><li>Tire print do comprovante.</li><li><b>Anexe o comprovante</b> aqui embaixo e toque em <b>Enviar pedido</b>.</li></ol>
      <label class="up${receipt ? ' ok' : ''}" id="up"><span class="uico" id="uico">${receipt ? '' : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.5l-8.5 8.5a6 6 0 0 1-8.5-8.5L12.5 4a4 4 0 0 1 5.7 5.7L9.6 18.3a2 2 0 0 1-2.8-2.8L15 7.3"/></svg>'}</span><div><b>${receipt ? 'Comprovante anexado' : 'Anexar comprovante do Pix'}</b><span>${receipt ? esc(receipt.name) + ' · toque para trocar' : 'Foto, print ou PDF'}</span></div><input type="file" id="file" accept="image/*,application/pdf"></label>
      <div class="alert" id="pAlert"><b class="h">Seu pedido só vale com o comprovante</b>Depois de pagar, anexe o print do Pix e toque em <b>Enviar pedido</b>. Você recebe o número do pedido na hora e acompanha o status por aqui.</div>
      <p class="err" id="eSend" hidden></p>`;
    if (receipt && receipt.type.startsWith('image/')) { const u = $('#uico'); u.style.backgroundImage = `url('${URL.createObjectURL(receipt)}')`; }
    $('#cpCode').onclick = () => copyText(pix.payload, 'Código Pix copiado');
    $('#cpKey').onclick = () => copyText(String(S.pix_key).replace(/[^\d+]/g, '').replace(/^\+55/, ''), 'Chave copiada');
    $('#file').onchange = (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 10 * 1024 * 1024) { toast('Arquivo muito grande (máx. 10 MB)'); return; } receipt = f; PixView.render(); };
    const need = S.require_receipt && !receipt;
    $('#shFoot').innerHTML = `<button class="cta dark" type="button" id="send" ${need ? 'aria-disabled="true"' : ''}><span>${need ? 'Anexe o comprovante' : 'Enviar pedido'}</span><span class="price">${brl(pix.total_cents)}</span></button>`;
    $('#send').onclick = () => {
      if (need) { const a = $('#up'); a.classList.remove('nudge'); void a.offsetWidth; a.classList.add('nudge'); a.scrollIntoView({ block: 'center', behavior: 'smooth' }); toast('Anexe o comprovante do Pix'); return; }
      sendOrder();
    };
  } };

  async function sendOrder() {
    if (sending) return; sending = true;
    const btn = $('#send'); btn.disabled = true; btn.firstElementChild.textContent = 'Enviando…';
    try {
      const fd = new FormData();
      fd.append('name', cliente.nome); fd.append('phone', cliente.tel); fd.append('notes', cliente.obs);
      fd.append('items', JSON.stringify(pedido.items)); fd.append('delivery', JSON.stringify(pedido.delivery));
      if (receipt) fd.append('receipt', receipt);
      const r = await fetch('/api/orders', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      pedido.order = j.order;
      const mine = store.get('mn_orders', []); mine.unshift({ code: j.order.code, number: j.order.number }); store.set('mn_orders', mine.slice(0, 20));
      bag = {}; saveBag(); receipt = null;
      history_ = []; show(DoneView);
    } catch (e) {
      const el = $('#eSend'); el.hidden = false; el.textContent = e.message || 'Não foi possível enviar. Tente novamente.';
      btn.disabled = false; btn.firstElementChild.textContent = 'Enviar pedido';
    } finally { sending = false; }
  }

  /* concluído */
  function orderText(o) {
    const L = [], ent = o.delivery_mode === 'entrega';
    L.push(`*Pedido #${o.number} · ${S.team_name}*`, `Noite do Hambúrguer · ${S.event_date_label}`, '');
    L.push(`*Nome:* ${o.customer_name}`, `*Telefone:* ${cliente.tel}`, '', '*Itens:*');
    o.items.forEach((l) => L.push(`${l.qty}× ${l.name} — ${brl(l.subtotal_cents)}`));
    L.push('', `*Recebimento:* ${ent ? 'Entrega' : `Retirada no local${S.pickup_address ? ` (${S.pickup_address})` : ''}`}`);
    if (ent) { L.push(`*Bairro:* ${o.bairro}`, `*Endereço:* ${o.address}`); if (o.address_ref) L.push(`*Referência:* ${o.address_ref}`); }
    if (ent) L.push(`*Taxa de entrega:* ${o.delivery_fee_cents === null ? 'a combinar (acima de 5 km)' : brl(o.delivery_fee_cents)}`);
    L.push(`*Total pago no Pix:* ${brl(o.total_cents)}`, `*Acompanhar:* ${location.origin}/pedido?c=${o.code}`);
    if (cliente.obs) L.push(`*Obs.:* ${cliente.obs}`);
    return L.join('\n');
  }
  const DoneView = { render() {
    const o = pedido.order;
    $('#shTitle').textContent = 'Pedido enviado!';
    const far = o.delivery_mode === 'entrega' && o.delivery_fee_cents === null;
    const track = `/pedido?c=${encodeURIComponent(o.code)}`;
    $('#shBody').innerHTML = `<div class="done-ico"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg></div>
      <p class="center" style="margin:12px 0 0;color:var(--muted)">Número do pedido</p><p class="center code big" style="margin:0">#${esc(o.number)}</p>
      <p class="center" style="margin:6px 0 0"><span class="pill">${o.status_info.emoji} ${esc(o.status_info.label)}</span></p>
      <div class="info"><b class="h">Recebemos seu pedido, ${esc(o.customer_name.split(' ')[0])}!</b>A equipe vai conferir o comprovante e confirmar o pagamento. Guarde o número <b>#${esc(o.number)}</b> para a ${o.delivery_mode === 'entrega' ? 'entrega' : 'retirada'}.</div>
      <ol class="steps"><li>Acompanhe o status do pedido pelo botão abaixo (o link fica salvo neste celular).</li>${far ? `<li>Combine a taxa de entrega com a equipe no WhatsApp.</li>` : ''}<li>Dúvidas? Fale com a equipe no WhatsApp.</li></ol>
      <div class="field"><span class="legend">Resumo</span><div class="copybox" style="grid-template-columns:1fr"><code style="white-space:pre-wrap;overflow:visible">${esc(orderText(o).replace(/\*/g, ''))}</code></div></div>`;
    const wa = `https://wa.me/${S.whatsapp_number}?text=${encodeURIComponent(orderText(o))}`;
    $('#shFoot').innerHTML = `<a class="cta dark" href="${track}"><span>Acompanhar pedido</span><span class="price">#${esc(o.number)}</span></a>
      <a class="cta wa" href="${wa}" target="_blank" rel="noopener"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.5-1.1-2.9s.7-2.1 1-2.4c.3-.3.6-.3.8-.3h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.6-.1l2 1c.3.1.5.2.5.3.1.1.1.6-.1 1.2z"/></svg><span>Falar com a equipe no WhatsApp</span></a>`;
  } };

  load().catch(() => { $('#menu').innerHTML = '<p class="empty">Não foi possível carregar o cardápio. Recarregue a página.</p>'; });
})();

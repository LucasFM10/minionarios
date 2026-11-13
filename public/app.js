(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ls = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  let S = {}; // settings
  let products = [];
  let cart = ls.get('mn_cart', {}); // { productId: qty }
  let notes = '';
  let customer = ls.get('mn_customer', { name: '', phone: '' });
  let step = 0; // 0 sacola, 1 dados, 2 pix, 3 sucesso
  let pix = null;
  let receipt = null;
  let sending = false;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('on'), 1800);
  }

  // ---------- menu ----------
  async function load() {
    const r = await fetch('/api/menu').then((r) => r.json());
    S = r.settings;
    products = r.products;
    for (const id of Object.keys(cart)) if (!products.some((p) => String(p.id) === id)) delete cart[id];
    renderHeader();
    renderMenu();
    renderBag();
    renderMyOrders();
  }

  function renderHeader() {
    document.title = `${S.team_name} · Noite do Hambúrguer`;
    $('#teamName').textContent = S.team_name;
    $('#tagline').textContent = S.tagline;
    $('#subtitle').textContent = S.subtitle;
    $('#dateChip').textContent = '📅 ' + S.event_date_label;
    $('#pickupChip').textContent = '📍 ' + S.pickup_label;
    const ig = S.instagram ? `<a href="https://instagram.com/${encodeURIComponent(S.instagram)}" target="_blank" rel="noopener">@${esc(S.instagram)}</a>` : '';
    $('#locationNote').innerHTML = esc(S.location_note).replace('@' + esc(S.instagram), ig) || ig;
    if (S.avatar_image) {
      $('#avatar').style.backgroundImage = `url('${S.avatar_image}')`;
      $('#avatar').textContent = '';
    }
    if (S.cover_image) $('#cover').style.backgroundImage = `url('${S.cover_image}')`;
    $('#closedNotice').classList.toggle('hidden', S.accepting_orders);
  }

  function renderMenu() {
    const cats = [...new Set(products.map((p) => p.category))];
    $('#catnav').innerHTML = cats.map((c, i) => `<button data-cat="${i}" class="${i === 0 ? 'on' : ''}">${esc(c)}</button>`).join('');
    $('#menu').innerHTML = cats
      .map(
        (c, i) => `<h2 class="cat-title" id="cat-${i}">${esc(c)}</h2>` +
          products.filter((p) => p.category === c).map((p) => `
          <article class="product" data-id="${p.id}">
            <div class="info">
              <h3>${esc(p.name)}</h3>
              <p>${esc(p.description)}</p>
              <span class="price">${brl(p.price_cents)}</span>
            </div>
            <div class="pic" style="${p.image ? `background-image:url('${p.image}')` : ''}">${p.image ? '' : esc(p.emoji)}
              ${S.accepting_orders ? `<div class="stepper" data-stepper="${p.id}"></div>` : ''}
            </div>
          </article>`).join('')
      )
      .join('');
    products.forEach((p) => paintStepper(p.id));
    $('#catnav').onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const el = $('#cat-' + b.dataset.cat);
      window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 60, behavior: 'smooth' });
    };
    const heads = cats.map((_, i) => $('#cat-' + i));
    window.onscroll = () => {
      let cur = 0;
      heads.forEach((h, i) => { if (h.getBoundingClientRect().top < 90) cur = i; });
      document.querySelectorAll('#catnav button').forEach((b, i) => b.classList.toggle('on', i === cur));
    };
  }

  function stepperHTML(id) {
    const q = cart[id] || 0;
    return `<button class="minus" data-dec="${id}" aria-label="Remover">−</button><span class="q">${q}</span><button class="plus" data-inc="${id}" aria-label="Adicionar">+</button>`;
  }
  function paintStepper(id) {
    document.querySelectorAll(`[data-stepper="${id}"]`).forEach((el) => {
      el.innerHTML = stepperHTML(id);
      el.classList.toggle('single', !cart[id]);
    });
  }

  function changeQty(id, d) {
    const p = products.find((x) => x.id === +id);
    if (!p) return;
    const q = Math.max(0, Math.min(50, (cart[id] || 0) + d));
    if (q) cart[id] = q; else delete cart[id];
    ls.set('mn_cart', cart);
    paintStepper(id);
    renderBag();
    if (d > 0) toast(`${p.name} na sacola 🛍️`);
    if (!$('#sheet').classList.contains('hidden') && step === 0) renderSheet();
  }

  document.addEventListener('click', (e) => {
    const inc = e.target.closest('[data-inc]');
    const dec = e.target.closest('[data-dec]');
    if (inc) { e.stopPropagation(); changeQty(inc.dataset.inc, +1); }
    else if (dec) { e.stopPropagation(); changeQty(dec.dataset.dec, -1); }
    else if (S.accepting_orders) {
      const card = e.target.closest('.product');
      if (card && !cart[card.dataset.id]) changeQty(card.dataset.id, +1);
    }
  });

  const cartLines = () =>
    Object.entries(cart)
      .map(([id, qty]) => ({ p: products.find((x) => x.id === +id), qty }))
      .filter((l) => l.p);
  const cartTotal = () => cartLines().reduce((s, l) => s + l.p.price_cents * l.qty, 0);
  const cartCount = () => cartLines().reduce((s, l) => s + l.qty, 0);

  function renderBag() {
    const n = cartCount();
    $('#bagbar').classList.toggle('hidden', !n || !S.accepting_orders);
    $('#bagCount').textContent = n;
    $('#bagTotal').textContent = brl(cartTotal());
  }

  function renderMyOrders() {
    const mine = ls.get('mn_orders', []);
    const box = $('#myOrders');
    if (!mine.length) return box.classList.add('hidden');
    box.classList.remove('hidden');
    box.innerHTML = `<span>🧾</span><span>Seus pedidos: ${mine
      .slice(0, 4)
      .map((o) => `<a href="/pedido?c=${encodeURIComponent(o.code)}">#${esc(o.number)}</a>`)
      .join(' · ')} — toque para acompanhar.</span>`;
  }

  // ---------- sheet ----------
  function openSheet(s = 0) {
    step = s;
    $('#sheetBg').classList.remove('hidden');
    $('#sheet').classList.remove('hidden');
    requestAnimationFrame(() => { $('#sheetBg').classList.add('on'); $('#sheet').classList.add('on'); });
    document.body.style.overflow = 'hidden';
    renderSheet();
    history.pushState({ sheet: true }, '');
  }
  function closeSheet(fromPop) {
    $('#sheetBg').classList.remove('on');
    $('#sheet').classList.remove('on');
    setTimeout(() => { $('#sheetBg').classList.add('hidden'); $('#sheet').classList.add('hidden'); }, 250);
    document.body.style.overflow = '';
    if (step === 3) { step = 0; renderMenu(); renderBag(); renderMyOrders(); }
    if (!fromPop && history.state?.sheet) history.back();
  }
  window.addEventListener('popstate', () => { if (!$('#sheet').classList.contains('hidden')) closeSheet(true); });
  $('#openBag').onclick = () => openSheet(0);
  $('#sheetClose').onclick = () => closeSheet();
  $('#sheetBg').onclick = () => closeSheet();
  $('#sheetBack').onclick = () => (step > 0 && step < 3 ? (step--, renderSheet()) : closeSheet());

  function renderSheet() {
    const titles = ['Sua sacola', 'Seus dados', 'Pagamento via Pix', 'Pedido enviado!'];
    $('#sheetTitle').textContent = titles[step];
    $('#steps').classList.toggle('hidden', step === 3);
    document.querySelectorAll('#steps i').forEach((el, i) => el.classList.toggle('on', i <= step));
    $('#sheetBack').style.visibility = step === 3 ? 'hidden' : 'visible';
    $('#sheetBody').scrollTop = 0;
    [renderCartStep, renderDataStep, renderPixStep, renderDoneStep][step]();
  }

  function renderCartStep() {
    const lines = cartLines();
    if (!lines.length) {
      $('#sheetBody').innerHTML = `<p class="center muted" style="padding:40px 0">Sua sacola está vazia 🍔</p>`;
      $('#sheetFoot').innerHTML = `<button class="btn block light" id="goMenu">Ver cardápio</button>`;
      $('#goMenu').onclick = () => closeSheet();
      return;
    }
    $('#sheetBody').innerHTML = `
      <div class="card">
        ${lines.map((l) => `<div class="line"><div class="nm">${esc(l.p.name)}<small>${brl(l.p.price_cents)} cada</small></div>
          <div class="stepper" data-stepper="${l.p.id}">${stepperHTML(l.p.id)}</div>
          <b style="min-width:76px;text-align:right">${brl(l.p.price_cents * l.qty)}</b></div>`).join('')}
        <div class="total"><span>Total</span><span>${brl(cartTotal())}</span></div>
      </div>
      <label class="field"><span>Observações (opcional)</span>
        <textarea class="input" id="notes" maxlength="300" placeholder="Ex.: sem cebola, sem molho…">${esc(notes)}</textarea></label>
      <div class="notice"><span>📍</span><span>${esc(S.pickup_label)} · ${esc(S.event_date_label)}. ${esc(S.location_note)}</span></div>`;
    $('#notes').oninput = (e) => (notes = e.target.value);
    $('#sheetFoot').innerHTML = `<button class="btn block" id="next">Continuar · ${brl(cartTotal())}</button>`;
    $('#next').onclick = () => { step = 1; renderSheet(); };
  }

  function maskPhone(v) {
    const d = v.replace(/\D/g, '').slice(0, 11);
    if (d.length <= 2) return d ? `(${d}` : '';
    if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}`;
  }

  function renderDataStep() {
    $('#sheetBody').innerHTML = `
      <p class="muted" style="margin-top:0">Usamos esses dados para identificar seu pedido na retirada.</p>
      <label class="field"><span>Nome completo</span><input class="input" id="name" autocomplete="name" maxlength="80" value="${esc(customer.name)}" placeholder="Seu nome" /></label>
      <label class="field"><span>WhatsApp / telefone</span><input class="input" id="phone" type="tel" inputmode="numeric" autocomplete="tel-national" value="${esc(maskPhone(customer.phone))}" placeholder="(83) 99999-9999" /></label>
      <div class="card"><b>💠 Pagamento antecipado via Pix</b><p class="small muted" style="margin:4px 0 0">A reserva é confirmada após o pagamento. Na próxima tela você recebe o QR Code e o código copia e cola.</p></div>
      <p class="err" id="err"></p>`;
    const valid = () => $('#name').value.trim().length >= 2 && $('#phone').value.replace(/\D/g, '').length >= 10;
    const upd = () => ($('#next').disabled = !valid());
    $('#phone').oninput = (e) => { e.target.value = maskPhone(e.target.value); upd(); };
    $('#name').oninput = upd;
    $('#sheetFoot').innerHTML = `<button class="btn block" id="next">Ir para o pagamento</button>`;
    upd();
    $('#next').onclick = async () => {
      customer = { name: $('#name').value.trim(), phone: $('#phone').value.replace(/\D/g, '') };
      ls.set('mn_customer', customer);
      $('#next').disabled = true;
      $('#next').textContent = 'Gerando Pix…';
      try {
        const r = await fetch('/api/pix', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: cartLines().map((l) => ({ product_id: l.p.id, qty: l.qty })) }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        pix = j;
        step = 2;
        renderSheet();
      } catch (e) {
        $('#err').textContent = e.message || 'Erro ao gerar o Pix. Tente novamente.';
        $('#next').disabled = false;
        $('#next').textContent = 'Ir para o pagamento';
      }
    };
  }

  function renderPixStep() {
    $('#sheetBody').innerHTML = `
      <div class="card">
        <div class="amount"><span class="muted small">Valor do pedido</span><b>${brl(pix.total_cents)}</b></div>
        <img class="qr" src="${pix.qr}" alt="QR Code Pix" />
        <p class="center small muted" style="margin:0 0 12px">Recebedor: <b>${esc(S.pix_name)}</b> · Chave: ${esc(S.pix_key)}</p>
        <div class="copybox"><code id="pixCode">${esc(pix.payload)}</code><button class="btn sm yellow" id="copy">Copiar</button></div>
      </div>
      <div class="card">
        <ol class="howto">
          <li><span>Toque em <b>Copiar</b> para copiar o código Pix (ou escaneie o QR Code de outro celular).</span></li>
          <li><span>Abra o app do seu banco, escolha <b>Pix copia e cola</b> e cole o código.</span></li>
          <li><span>Confira o valor de <b>${brl(pix.total_cents)}</b> e pague.</span></li>
          <li><span>Volte aqui, <b>anexe o comprovante</b> e envie o pedido.</span></li>
        </ol>
      </div>
      <label class="upload ${receipt ? 'ok' : ''}" id="up">
        <span class="thumb ${receipt ? '' : 'hidden'}" id="thumb"></span>
        <span class="ico ${receipt ? 'hidden' : ''}">📎</span>
        <span style="flex:1"><b id="upTitle">${receipt ? 'Comprovante anexado' : 'Anexar comprovante'}</b><br /><span class="small muted" id="upSub">${receipt ? esc(receipt.name) + ' · toque para trocar' : 'Foto, print ou PDF do Pix'}</span></span>
        <input type="file" id="file" accept="image/*,application/pdf" />
      </label>
      <p class="err" id="err"></p>`;
    if (receipt && receipt.type.startsWith('image/')) $('#thumb').style.backgroundImage = `url('${URL.createObjectURL(receipt)}')`;
    $('#copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(pix.payload);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = pix.payload;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      $('#copy').textContent = 'Copiado ✓';
      toast('Código Pix copiado! Cole no app do banco.');
    };
    $('#file').onchange = (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (f.size > 10 * 1024 * 1024) return ($('#err').textContent = 'Arquivo muito grande (máx. 10 MB).');
      receipt = f;
      renderPixStep();
    };
    const need = S.require_receipt;
    $('#sheetFoot').innerHTML = `<button class="btn block green" id="send" ${need && !receipt ? 'disabled' : ''}>${need && !receipt ? 'Anexe o comprovante para enviar' : 'Enviar pedido'}</button>`;
    $('#send').onclick = sendOrder;
  }

  async function sendOrder() {
    if (sending) return;
    sending = true;
    const btn = $('#send');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const fd = new FormData();
      fd.append('name', customer.name);
      fd.append('phone', customer.phone);
      fd.append('notes', notes);
      fd.append('items', JSON.stringify(cartLines().map((l) => ({ product_id: l.p.id, qty: l.qty }))));
      if (receipt) fd.append('receipt', receipt);
      const r = await fetch('/api/orders', { method: 'POST', body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      const mine = ls.get('mn_orders', []);
      mine.unshift({ code: j.order.code, number: j.order.number });
      ls.set('mn_orders', mine.slice(0, 20));
      window.__lastOrder = j.order;
      cart = {};
      notes = '';
      receipt = null;
      ls.set('mn_cart', cart);
      step = 3;
      renderSheet();
    } catch (e) {
      $('#err').textContent = e.message || 'Não foi possível enviar. Tente novamente.';
      btn.disabled = false;
      btn.textContent = 'Enviar pedido';
    } finally {
      sending = false;
    }
  }

  function renderDoneStep() {
    const o = window.__lastOrder;
    const url = `${location.origin}/pedido?c=${encodeURIComponent(o.code)}`;
    const msg = `Olá! Fiz o pedido *#${o.number}* na pré-venda da ${S.team_name} 🍔\nNome: ${o.customer_name}\n${o.items.map((l) => `${l.qty}x ${l.name}`).join('\n')}\nTotal: ${brl(o.total_cents)} (Pix)\nAcompanhar: ${url}`;
    $('#sheetBody').innerHTML = `
      <div class="center" style="padding:8px 0 4px">
        <div style="font-size:48px">🎉</div>
        <p class="muted" style="margin:4px 0 0">Número do seu pedido</p>
        <div class="bignum">#${esc(o.number)}</div>
        <p style="margin:0 0 14px">Obrigado, <b>${esc(o.customer_name.split(' ')[0])}</b>! Guarde esse número para a retirada.</p>
      </div>
      <div class="card">
        <div class="total" style="padding:0 0 8px"><span>Status</span><span class="pill ${o.status}">${o.status_info.emoji} ${esc(o.status_info.label)}</span></div>
        <p class="small muted" style="margin:0">A equipe vai conferir o comprovante e confirmar o pagamento. Acompanhe pelo link abaixo — ele também fica salvo neste celular.</p>
      </div>
      <div class="notice"><span>📍</span><span>${esc(S.location_note)}</span></div>`;
    $('#sheetFoot').innerHTML = `
      <a class="btn block" href="${url}">Acompanhar pedido</a>
      <a class="btn block light" style="margin-top:8px" target="_blank" rel="noopener" href="https://wa.me/${esc(S.whatsapp_number)}?text=${encodeURIComponent(msg)}">Enviar no WhatsApp da equipe</a>`;
  }

  load().catch(() => ($('#menu').innerHTML = '<p class="center err" style="padding:40px 0">Não foi possível carregar o cardápio. Recarregue a página.</p>'));
})();

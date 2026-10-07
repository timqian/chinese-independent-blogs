// Progressive enhancement for the server-rendered pages: voting and following
// without a reload, and directory search. Everything also works
// without this script.
(() => {
  const $ = (s) => document.querySelector(s);

  // Favicons that fail to load fall back to the letter tile underneath
  document.addEventListener('error', (e) => { if (e.target.matches?.('.av img')) e.target.remove(); }, true);

  // Send email login codes in place and reveal the code field without navigating.
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form.email-login');
    if (!form) return;
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const error = $('#login-error');
    const verification = $('#verification');
    const codeEmail = verification?.querySelector('input[name="email"]');
    const codeSent = $('#code-sent');
    const email = form.querySelector('input[type="email"]').value;
    button.disabled = true;
    error.hidden = true;
    const label = button.textContent;
    button.textContent = '正在发送…';
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        headers: { Accept: 'application/json' },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '验证码发送失败，请稍后再试。');
      codeEmail.value = data.email;
      codeSent.querySelector('b').textContent = data.email;
      verification.hidden = false;
      verification.querySelector('#code').focus();
      button.textContent = '重新发送验证码';
    } catch (err) {
      error.textContent = err.message || '网络错误，请稍后重试。';
      error.hidden = false;
      button.textContent = label;
    } finally {
      button.disabled = false;
    }
  });

  let toastTimer;
  const toast = (msg) => {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 1800);
  };

  // ---------- vote and follow forms ----------
  // Both are plain POST forms; this sends them with fetch() and updates in place.
  const update = {
    vote(form, data) {
      form.querySelector('button').setAttribute('aria-pressed', data.voted);
      form.querySelector('.score').textContent = data.score || '';
    },
    follow(form, data) {
      const button = form.querySelector('button');
      button.setAttribute('aria-pressed', data.following);
      button.textContent = data.following ? '已关注' : '关注';
      const count = form.closest('.follow-box')?.querySelector('.followers');
      if (count && typeof data.followers === 'number') {
        count.textContent = `${data.followers} 人关注`;
        // Directory rows hide a zero count; blog pages always show it
        if (data.followers) count.hidden = false;
      }
      toast(data.following ? '已关注' : '已取消关注');
    },
  };
  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form.vote, form.follow-form');
    if (!form) return;
    e.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const res = await fetch(form.action, { method: 'POST', body: new FormData(form), headers: { Accept: 'application/json' } });
      const data = await res.json();
      if (res.status === 401 && data.login) { location.href = data.login; return; }
      if (!res.ok) { toast(data.error || '操作失败，请稍后重试'); return; }
      update[form.classList.contains('vote') ? 'vote' : 'follow'](form, data);
    } catch {
      toast('网络错误，请稍后重试');
    } finally {
      button.disabled = false;
    }
  });

  // ---------- avatar upload: crop to a square and shrink before sending ----------
  const avatarForm = $('#avatar-form');
  if (avatarForm) {
    const SIZE = 160;
    let resized = null;
    const input = $('#avatar');
    input.addEventListener('change', async () => {
      resized = null;
      const file = input.files[0];
      if (!file) return;
      try {
        const img = await createImageBitmap(file);
        const side = Math.min(img.width, img.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = SIZE;
        canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, SIZE, SIZE);
        resized = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.85));
        if (resized?.type !== 'image/webp') resized = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
        $('#avatar-preview').innerHTML = `<span class="av round xl"><img src="${URL.createObjectURL(resized)}" alt=""></span>`;
      } catch {
        resized = null;  // fall back to uploading the original file
      }
    });
    avatarForm.addEventListener('submit', async (e) => {
      if (!resized) return;
      e.preventDefault();
      const body = new FormData();
      body.append('avatar', resized, resized.type === 'image/webp' ? 'avatar.webp' : 'avatar.jpg');
      const res = await fetch(avatarForm.action, { method: 'POST', body });
      if (res.redirected) { location.href = res.url; return; }
      // Validation error: show the settings page the server rendered
      const html = await res.text();
      document.open();
      document.write(html);
      document.close();
    });
  }

  // ---------- directory search and category filter ----------
  const list = $('#bloglist');
  if (list) {
    const items = [...list.children];
    let cat = '';
    const apply = () => {
      const q = $('#q').value.trim().toLowerCase();
      let shown = 0;
      for (const li of items) {
        const ok = (!q || li.dataset.search.includes(q)) && (!cat || li.dataset.cats.split(' ').includes(cat));
        li.hidden = !ok;
        if (ok) shown++;
      }
      $('#result-count').textContent = `共 ${shown} 个博客`;
    };
    $('#q').addEventListener('input', apply);
    $('#dir-chips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (!b) return;
      cat = b.dataset.cat;
      document.querySelectorAll('#dir-chips [data-cat]').forEach((x) => x.setAttribute('aria-pressed', x === b));
      apply();
    });
  }
})();

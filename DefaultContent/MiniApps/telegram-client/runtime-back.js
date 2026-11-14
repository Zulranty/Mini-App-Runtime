if (window.mini?.app) {
  const back = document.createElement('button');
  back.type = 'button';
  back.textContent = '←';
  back.title = 'Back';
  back.addEventListener('click', () => window.mini.app.close());
  document.body.prepend(back);
}

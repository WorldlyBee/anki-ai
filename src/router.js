// Hash routes: #/ (decks), #/study/<deckId>, #/settings
let leaveHandlers = [];
let renderRoute = () => {};

export function onLeave(fn) {
  leaveHandlers.push(fn);
}

export function navigate(hash) {
  if (location.hash === hash) renderRoute();
  else location.hash = hash;
}

export function startRouter(render) {
  renderRoute = () => {
    leaveHandlers.forEach((fn) => fn());
    leaveHandlers = [];
    const [, page, arg] = (location.hash || '#/').split('/');
    render(page || '', arg);
  };
  window.addEventListener('hashchange', renderRoute);
  renderRoute();
}

(() => {
  'use strict';

  // Safari/iOS can retarget taps when our non-button context trigger lives inside
  // an existing button card. Handle the touch before the parent card receives it,
  // then dispatch a non-bubbling click directly to the trigger's existing handler.
  let syntheticTouchAt = 0;

  function triggerFromEvent(event) {
    const target = event.target;
    return target instanceof Element ? target.closest('.context-menu-trigger') : null;
  }

  function activateTouchTrigger(event) {
    const trigger = triggerFromEvent(event);
    if (!trigger) return;
    const now = Date.now();
    if (now - syntheticTouchAt < 180) return;
    syntheticTouchAt = now;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    trigger.dispatchEvent(
      new MouseEvent('click', {
        view: window,
        bubbles: false,
        cancelable: true,
      })
    );
  }

  document.addEventListener(
    'pointerup',
    event => {
      if (event.pointerType === 'touch' || event.pointerType === 'pen') activateTouchTrigger(event);
    },
    true
  );

  document.addEventListener(
    'touchend',
    event => {
      // Fallback for Safari versions/devices where Pointer Events are incomplete.
      if (Date.now() - syntheticTouchAt < 180) return;
      activateTouchTrigger(event);
    },
    { capture: true, passive: false }
  );

  document.addEventListener(
    'click',
    event => {
      if (!event.isTrusted || Date.now() - syntheticTouchAt > 700) return;
      if (!triggerFromEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    },
    true
  );
})();

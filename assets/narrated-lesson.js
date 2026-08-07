// Global Market School — Narrated Lesson Engine
//
// Turns a plain data object (title + an array of slides, each with a
// visual and a narration script) into a self-paced "voice presentation":
// the browser's built-in text-to-speech reads each slide's narration
// aloud while the matching sentence is highlighted on screen, and the
// deck auto-advances to the next slide when narration finishes.
//
// This is real, working narration -- the browser's native
// speechSynthesis API -- not a placeholder. It does not require any
// external service, audio file, or network request, and it degrades
// gracefully (silently, with working Next/Prev buttons) on the rare
// browser that doesn't support speech synthesis at all.
//
// Usage: each lesson page defines a `LESSON` object, includes this
// script, and calls `NarratedLesson.render(LESSON, '#lesson-root')`.

(function () {
  "use strict";

  function splitSentences(text) {
    // Split narration into sentence-sized chunks so we can highlight
    // roughly what's being spoken right now, without needing real
    // word-level timing data (SpeechSynthesis boundary events are
    // unreliable across browsers/voices, so sentence-level is the
    // honest, robust choice).
    const matches = text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g);
    return matches ? matches.map(function (s) { return s.trim(); }).filter(Boolean) : [text];
  }

  function render(LESSON, rootSelector) {
    const root = document.querySelector(rootSelector);
    if (!root) return;

    let current = 0;
    let playing = false;
    let sentenceIndex = 0;
    let voicesReady = false;
    const supportsSpeech = "speechSynthesis" in window;

    root.innerHTML =
      '<div class="nl-head">' +
        '<span class="nl-kicker" id="nl-kicker"></span>' +
        '<div class="nl-dots" id="nl-dots"></div>' +
      '</div>' +
      '<div class="nl-stage" id="nl-stage"></div>' +
      '<div class="nl-caption" id="nl-caption"></div>' +
      '<div class="nl-controls">' +
        '<button type="button" class="nl-btn nl-btn-ghost" id="nl-prev">&larr; Prev</button>' +
        '<button type="button" class="nl-btn nl-btn-primary" id="nl-play"' + (supportsSpeech ? '' : ' disabled') + '>' + (supportsSpeech ? '&#9658; Play Narration' : 'Voice not supported — read below') + '</button>' +
        '<button type="button" class="nl-btn nl-btn-ghost" id="nl-next">Next &rarr;</button>' +
      '</div>' +
      (supportsSpeech ? '' : '<p class="nl-fallback-note">Your browser doesn\'t support voice narration. You can still read every slide and move through the lesson with Prev / Next.</p>');

    const dotsEl = document.getElementById('nl-dots');
    LESSON.slides.forEach(function (_, i) {
      const dot = document.createElement('span');
      dot.className = 'nl-dot' + (i === 0 ? ' active' : '');
      dot.addEventListener('click', function () { goTo(i); });
      dotsEl.appendChild(dot);
    });

    function updateDots() {
      Array.from(dotsEl.children).forEach(function (d, i) {
        d.classList.toggle('active', i === current);
        d.classList.toggle('done', i < current);
      });
    }

    function stopSpeech() {
      if (supportsSpeech) window.speechSynthesis.cancel();
      playing = false;
      document.getElementById('nl-play').innerHTML = '&#9658; Play Narration';
    }

    function renderSlide() {
      const slide = LESSON.slides[current];
      document.getElementById('nl-kicker').textContent = slide.kicker || ('Slide ' + (current + 1) + ' of ' + LESSON.slides.length);
      document.getElementById('nl-stage').innerHTML = slide.visual;
      const sentences = splitSentences(slide.narration);
      document.getElementById('nl-caption').innerHTML = sentences.map(function (s, i) {
        return '<span class="nl-sentence" data-i="' + i + '">' + s + ' </span>';
      }).join('');
      sentenceIndex = 0;
      updateDots();
      document.getElementById('nl-prev').disabled = current === 0;
      const nextBtn = document.getElementById('nl-next');
      if (current === LESSON.slides.length - 1) {
        nextBtn.textContent = LESSON.nextLabel || 'Finish →';
      } else {
        nextBtn.textContent = 'Next →';
      }
    }

    function highlightSentence(i) {
      root.querySelectorAll('.nl-sentence').forEach(function (el) {
        el.classList.toggle('speaking', Number(el.getAttribute('data-i')) === i);
      });
    }

    function speakCurrentSlide() {
      if (!supportsSpeech) return;
      window.speechSynthesis.cancel();
      const sentences = splitSentences(LESSON.slides[current].narration);
      let i = 0;

      function speakNext() {
        if (i >= sentences.length) {
          playing = false;
          document.getElementById('nl-play').innerHTML = '&#9658; Play Narration';
          root.querySelectorAll('.nl-sentence').forEach(function (el) { el.classList.remove('speaking'); });
          if (current < LESSON.slides.length - 1) {
            setTimeout(function () {
              if (!playing) goTo(current + 1, true);
            }, 900);
          }
          return;
        }
        highlightSentence(i);
        const utter = new SpeechSynthesisUtterance(sentences[i]);
        utter.rate = 0.97;
        utter.pitch = 1;
        const voices = window.speechSynthesis.getVoices();
        const preferred = voices.find(function (v) { return /en-US|en-GB|en_/.test(v.lang) && /female|male/i.test(v.name) === false; }) ||
          voices.find(function (v) { return v.lang && v.lang.indexOf('en') === 0; });
        if (preferred) utter.voice = preferred;
        utter.onend = function () { i++; if (playing) speakNext(); };
        utter.onerror = function () { i++; if (playing) speakNext(); };
        window.speechSynthesis.speak(utter);
      }
      speakNext();
    }

    function goTo(index, autoplay) {
      if (index < 0 || index >= LESSON.slides.length) {
        if (index >= LESSON.slides.length && LESSON.nextHref) {
          window.location.href = LESSON.nextHref;
        }
        return;
      }
      stopSpeech();
      current = index;
      renderSlide();
      if (autoplay) togglePlay(true);
    }

    function togglePlay(forcePlay) {
      if (!supportsSpeech) return;
      if (playing && forcePlay !== true) {
        window.speechSynthesis.pause();
        playing = false;
        document.getElementById('nl-play').innerHTML = '&#9658; Resume';
        return;
      }
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
        playing = true;
        document.getElementById('nl-play').innerHTML = '&#10074;&#10074; Pause';
        return;
      }
      playing = true;
      document.getElementById('nl-play').innerHTML = '&#10074;&#10074; Pause';
      speakCurrentSlide();
    }

    document.getElementById('nl-play').addEventListener('click', function () { togglePlay(); });
    document.getElementById('nl-prev').addEventListener('click', function () { goTo(current - 1); });
    document.getElementById('nl-next').addEventListener('click', function () { goTo(current + 1); });

    // Chrome loads voices asynchronously; nothing to do but let it
    // happen -- getVoices() is called fresh at speak-time above.
    if (supportsSpeech) {
      window.speechSynthesis.onvoiceschanged = function () { voicesReady = true; };
    }

    renderSlide();

    window.addEventListener('beforeunload', stopSpeech);
  }

  window.NarratedLesson = { render: render };
})();

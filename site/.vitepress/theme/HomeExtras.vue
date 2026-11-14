<script setup lang="ts">
import { withBase } from 'vitepress'
import todos from '../../../assets/todos.png'
import chat from '../../../assets/chat.png'
import orgMap from '../../../assets/org-map.png'

const shots = [
  { src: todos, alt: 'The Todo board, with tickets in To do, Blocked, In progress, In review and Closed columns', caption: 'The Todo board' },
  { src: chat, alt: 'A chat with the COO drafting a release checklist, with a code block and a linked Todo', caption: 'Chat' },
  { src: orgMap, alt: 'The org chart of AI employees grouped into departments', caption: 'The org chart' },
]
</script>

<template>
  <div class="hf-extras">
    <section class="hf-section" aria-labelledby="hf-install">
      <h2 id="hf-install">Install</h2>
      <div class="hf-glass hf-install">
        <pre><code>npm i -g hundredfold</code></pre>
        <p>
          The npm package arrives with the first release. Until then,
          <a :href="withBase('/getting-started#development')">build it from source</a>.
          You need Node.js and at least one agent CLI signed in.
        </p>
      </div>
    </section>

    <section class="hf-section" aria-labelledby="hf-shots">
      <h2 id="hf-shots">What it looks like</h2>
      <div class="hf-shots">
        <figure v-for="shot in shots" :key="shot.caption" class="hf-glass hf-shot">
          <img :src="shot.src" :alt="shot.alt" loading="lazy" width="2880" height="1800" />
          <figcaption>{{ shot.caption }}</figcaption>
        </figure>
      </div>
    </section>

    <section class="hf-section hf-credit" aria-labelledby="hf-credit">
      <h2 id="hf-credit">Built on Jinn</h2>
      <p>
        Hundredfold is built on <a href="https://github.com/hristo2612/jinn">Jinn</a> by hristo2612 and
        contributors (MIT). Most of the code is theirs. See <a :href="withBase('/marid-vs-jinn')">how the two compare</a>.
      </p>
      <p class="hf-links">
        <a href="https://github.com/hundredfoldhq/hundredfold">GitHub</a>
        <a :href="withBase('/getting-started')">Documentation</a>
      </p>
    </section>
  </div>
</template>

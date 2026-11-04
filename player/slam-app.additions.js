// Excerpts from the HACKAR:S WebAR player (docs/slam-app.js, closed source, pre-existing product),
// showing ONLY the additions written during the Meta Global AI Developer Hackathon (Oct 26 - Nov 4, 2026).
// They are not runnable on their own: they live inside the player's overlay builder and use its
// globals (THREE r160, window.arCamera / arScene / arRenderer, the SLAM group). Every addition is
// opt-in per project (isUltraFx / isHandPlay overlays, or a GLB with an 'idle' clip): other HACKAR:S
// projects never load any of it.

// ---- GLB named clips: switch animations by name (emotions) ----
          // Named clips (idle / happy / talk / dangle / land / zap …): Hand Play switches them by name
          if (gltf.animations.some(c => c.name === 'idle')) {
            const byName = {}
            gltf.animations.forEach(c => { byName[c.name] = c })
            let cur = action
            const ONCE = ['happy', 'surprised', 'sad', 'angry', 'land', 'zap']
            const play = (name) => {
              const clip = byName[name]
              if (!clip) return false
              const next = mixer.clipAction(clip)
              if (next === cur && next.isRunning()) return true
              next.reset()
              if (ONCE.includes(name)) { next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true } else next.setLoop(THREE.LoopRepeat, Infinity)
              next.play()
              if (cur && cur !== next) cur.crossFadeTo(next, 0.18, false)
              cur = next
              return true
            }
            mixer.addEventListener('finished', (e) => { if (e.action === cur && ONCE.includes(e.action.getClip().name)) play('idle') })
            play('idle')
            container.userData.playClip = play
            if (!window.__charClips) window.__charClips = {}
            window.__charClips[ov.id] = { play, names: Object.keys(byName) }
          }

// ---- loading spinner while hand tracking / spells get ready ----
    // MOSHI MOSHI loading indicator: a spinner while the hand tracker / spell effects get ready
    // (compiling them can stall the page for a moment). The spin is a compositor-only CSS animation,
    // so it keeps turning even while the main thread is busy.
    const _creatorLoads = new Set()
    let _creatorLoader = null
// ---- creatorLoading() ----
    function creatorLoading(key) {
      if (!_creatorLoader) {
        const st = document.createElement('style')
        st.textContent = '@keyframes crspin{to{transform:rotate(360deg)}}'
          + '.cr-load{position:fixed;left:50%;top:50%;z-index:70;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px 26px;border-radius:20px;'
          + 'background:rgba(20,20,28,.45);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);color:#fff;font:600 14px/1.3 -apple-system,"Hiragino Sans",sans-serif;pointer-events:none;transition:opacity .35s}'
          + '.cr-load i{display:block;width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.25);border-top-color:#fff;animation:crspin .8s linear infinite;will-change:transform}'
        document.head.appendChild(st)
        _creatorLoader = document.createElement('div')
        _creatorLoader.className = 'cr-load'
        _creatorLoader.innerHTML = '<i></i><span>' + (/^ja/.test(navigator.language) ? 'ARを準備中…' : 'Getting AR ready…') + '</span>'
        document.body.appendChild(_creatorLoader)
      }
      _creatorLoads.add(key)
      _creatorLoader.style.opacity = '1'
      return () => {
        _creatorLoads.delete(key)
        if (!_creatorLoads.size) _creatorLoader.style.opacity = '0'
      }
    }

// ---- Ultra Elements spell overlay (character-sized, occluded by the character, frozen while carried) ----
    function buildUltraFxOverlay(ov, parent) {
      const localBox = new THREE.Box3(), _b = new THREE.Box3(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _e = new THREE.Euler()
      const marker = new THREE.Object3D()
      marker.name = 'overlay_' + ov.id
      marker.userData._overlayId = ov.id
      parent.add(marker)
      let ready = false, group = null, lastAnchor = null
      const measure = () => {
        group.updateMatrixWorld(true)
        const inv = new THREE.Matrix4().copy(group.matrixWorld).invert()
        localBox.makeEmpty()
        group.traverse(o => {
          if (!o.isMesh || !o.geometry || o.userData._ultraSkip) return
          let p = o, glb = false
          while (p && p !== group) { if (p.userData._isGLBContainer) { glb = true; break } p = p.parent }
          if (!glb && !o.isSkinnedMesh) return
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
          _b.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld).applyMatrix4(inv)
          localBox.union(_b)
        })
        ready = !localBox.isEmpty()
      }
      const getAnchor = () => {
        if (marker.parent !== group) { group = marker.parent; ready = false; occMeshes = null }
        if (!group || !group.parent || !group.visible) return null
        if (!ready) { measure(); if (!ready) return null }
        // Hand Play: while the character is carried / falling, spells stay where it was picked up
        // (a floor sigil sliding along with the hand looks wrong); they follow again once it lands
        if (window.__handPlay && window.__handPlay.carried && lastAnchor) return lastAnchor
        group.matrixWorld.decompose(_p, _q, _s)
        const c = localBox.getCenter(new THREE.Vector3()).setY(localBox.min.y).applyMatrix4(group.matrixWorld)
        _e.setFromQuaternion(_q, 'YXZ')
        lastAnchor = { position: [c.x, c.y, c.z], yaw: _e.y, height: (localBox.max.y - localBox.min.y) * _s.y * (ov.ultraScale || 1) }
        return lastAnchor
      }
      // the character's triangles in AR world space (skinned on the CPU), so Ultra can hide the parts
      // of a spell that are behind it. Shadow planes and see-through helpers are left out.
      let occMeshes = null
      const _v = new THREE.Vector3()
      const getOccluder = () => {
        if (!group || !ready || ov.ultraOcclude === false) return null
        if (!occMeshes) {
          occMeshes = []
          group.traverse(o => {
            if (!o.isMesh || !o.geometry?.attributes?.position) return
            let p = o, glb = false
            while (p && p !== group) { if (p.userData._isGLBContainer) { glb = true; break } p = p.parent }
            if (!glb) return
            const m = Array.isArray(o.material) ? o.material[0] : o.material
            if (/shadow/i.test(o.name || '') || m?.isShadowMaterial || (m?.transparent && m?.depthWrite === false)) return
            const g = o.geometry, n = g.attributes.position.count
            let uv = null
            if (g.attributes.uv) { uv = new Float32Array(n * 2); for (let i = 0; i < n; i++) { uv[i * 2] = g.attributes.uv.getX(i); uv[i * 2 + 1] = g.attributes.uv.getY(i) } }
            occMeshes.push({ src: o, out: { key: o.uuid, position: new Float32Array(n * 3), uv, index: g.index ? new Uint32Array(g.index.array) : null } })
          })
        }
        const list = []
        for (const e of occMeshes) {
          const o = e.src
          if (!o.visible || !o.parent) continue
          let vis = true
          for (let p = o; p; p = p.parent) if (!p.visible) { vis = false; break }
          if (!vis) continue
          const m = Array.isArray(o.material) ? o.material[0] : o.material
          const map = m && m.map && (m.alphaTest > 0 || m.transparent) ? m.map : null
          e.out.image = map ? map.image : null
          e.out.flipY = map ? map.flipY : false
          e.out.alphaTest = m && m.alphaTest > 0 ? m.alphaTest : 0.5
          const pos = o.geometry.attributes.position, a = e.out.position
          for (let i = 0; i < pos.count; i++) {
            _v.fromBufferAttribute(pos, i)
            if (o.isSkinnedMesh) o.applyBoneTransform(i, _v)
            _v.applyMatrix4(o.matrixWorld)
            a[i * 3] = _v.x; a[i * 3 + 1] = _v.y; a[i * 3 + 2] = _v.z
          }
          list.push(e.out)
        }
        return list
      }
      const canvas = window.arRenderer && window.arRenderer.domElement
      const loaded = creatorLoading('ultra')
      import('/fx/ultra/ultra-host.js?v=20261103j').then(m => {
        const ctl = m.start({
          getCamera: () => window.arCamera, getAnchor, getOccluder,
          spell: ov.ultraSpell || 'lightning', form: ov.ultraForm || '', interval: ov.ultraInterval || 3.5, exposure: ov.ultraExposure || 1,
          parent: (canvas && canvas.parentElement) || document.body, after: canvas,
        })
        if (!ctl) dbg('UltraFX: WebGL2 float targets unavailable, skipped')
        window.__ultraFx = ctl
        if (!ctl) loaded()
        else { const wait = () => (ctl.ready ? loaded() : setTimeout(wait, 150)); wait() }
        // Hand Play: an open palm toward the character casts the spell from the hand
        if (ctl) window.addEventListener('handplay:palm', (e) => ctl.cast({ from: e.detail && e.detail.from }))
      }).catch(e => { loaded(); dbg('UltraFX load failed: ' + e.message) })
    }

// ---- Hand Play overlay (pinch / poke / palm, talk, moves, wish game) ----
    // Hand Play (pinch to carry, poke to talk, palm to cast) — only projects with an isHandPlay overlay load it.
    function buildHandPlayOverlay(ov, parent) {
      // a floor character you touch with your hand: the selfie camera has nothing to show
      const camWrap = document.getElementById('camera-switcher-wrapper')
      if (camWrap && ov.handCameraSwitch !== true) camWrap.style.display = 'none'
      const marker = new THREE.Object3D()
      marker.name = 'overlay_' + ov.id
      marker.userData._overlayId = ov.id
      parent.add(marker)
      const canvas = window.arRenderer && window.arRenderer.domElement
      const loaded = creatorLoading('hand')
      import('/fx/hand/hand-play.js?v=20261103t').then(m => m.start({
        THREE, marker, getCamera: () => window.arCamera, scene: window.arScene, canvas, ov, dbg,
      })).then(ctl => { loaded(); window.__handPlay = ctl; if (!ctl) dbg('HandPlay: unavailable') })
        .catch(e => { loaded(); dbg('HandPlay load failed: ' + e.message) })
    }

// ---- two-finger twist: turn the way the fingers turn (MOSHI MOSHI projects only) ----
          // MOSHI MOSHI projects (Hand Play / Ultra FX): turn the way the fingers twist, and no jump at ±180°.
          // Other projects keep the original behaviour.
          const ovs = (window.__overlayData && Object.values(window.__overlayData).find(v => v && v.overlays)?.overlays) || []
          if (ovs.some(o => o.isHandPlay || o.isUltraFx)) {
            let d = angle - _slamPrevRotAngle
            if (d > Math.PI) d -= Math.PI * 2
            else if (d < -Math.PI) d += Math.PI * 2
            _slamGroup.rotation.y -= d
          } else {
            _slamGroup.rotation.y += (angle - _slamPrevRotAngle)
          }



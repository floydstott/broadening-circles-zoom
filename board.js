// Shared board rendering + movement helpers
// Exposes: BoardRender.init(svgEl, {interactive, onSlotClick, onPieceClick}), BoardRender.update(state)
// and logic helpers: Board.emptyState(), Board.place(), Board.moveForward(), Board.moveBackward()

var Board = (function(){

  // sectorAssignments: {research:'easy', patient:'medium', balanced:'hard'} — set at game start.
  // pieces: array of {id, team, color:'research'|'patient', sector:'easy'|'medium'|'hard', slot:int, removed:bool}

  function emptyState() {
    return { sectors: null, pieces: [], nextId: 1 };
  }

  function sectorLength(sectorId) { return SECTOR_LENGTHS[sectorId]; }

  function addPiece(state, team, color, sectorId) {
    var p = { id: state.nextId++, team: team, color: color, sector: sectorId, slot: 0, removed: false };
    state.pieces.push(p);
    return p;
  }

  function piecesAt(state, sectorId, slot) {
    return state.pieces.filter(function(p){ return !p.removed && p.sector===sectorId && p.slot===slot; });
  }

  // Two pieces at the same slot of opposite color => aligned
  function alignedAt(state, sectorId, slot) {
    var here = piecesAt(state, sectorId, slot);
    var colors = {};
    here.forEach(function(p){ colors[p.color] = true; });
    return colors.research && colors.patient ? here : null;
  }

  function isAligned(state, piece) {
    if (piece.removed) return false;
    return !!alignedAt(state, piece.sector, piece.slot);
  }

  function atEnd(state, piece) {
    return piece.slot >= sectorLength(piece.sector) - 1;
  }

  // Move a specific piece forward by n (clamped to end)
  function moveForward(state, pieceId, n) {
    var p = state.pieces.find(function(x){ return x.id===pieceId; });
    if (!p || p.removed) return;
    var L = sectorLength(p.sector);
    p.slot = Math.min(L - 1, p.slot + n);
    // If aligned, move the partner too
    // (Caller decides whether to trigger aligned movement; see moveAligned.)
  }

  // Move aligned pair forward by 2n (rules: together double the die roll)
  function moveAlignedForward(state, pieceId, dieRoll) {
    var p = state.pieces.find(function(x){ return x.id===pieceId; });
    if (!p || p.removed) return;
    var partners = alignedAt(state, p.sector, p.slot);
    if (!partners) return moveForward(state, pieceId, dieRoll);
    var L = sectorLength(p.sector);
    var target = Math.min(L - 1, p.slot + dieRoll * 2);
    partners.forEach(function(q){ q.slot = target; });
  }

  // Move piece backward (challenge). Aligned pieces cannot be moved backward.
  // Piece at end cannot be moved. If moves past slot 0, removed.
  function moveBackward(state, pieceId, n) {
    var p = state.pieces.find(function(x){ return x.id===pieceId; });
    if (!p || p.removed) return { ok:false, reason:"missing" };
    if (atEnd(state, p)) return { ok:false, reason:"end" };
    if (isAligned(state, p)) return { ok:false, reason:"aligned" };
    var newSlot = p.slot - n;
    if (newSlot < 0) {
      p.removed = true;
      return { ok:true, removed:true };
    }
    p.slot = newSlot;
    return { ok:true };
  }

  // Can this piece be moved backward (for challenge target selection)?
  function canMoveBackward(state, p) {
    if (p.removed) return false;
    if (atEnd(state, p)) return false;
    if (isAligned(state, p)) return false;
    return true;
  }

  return {
    emptyState: emptyState,
    sectorLength: sectorLength,
    addPiece: addPiece,
    piecesAt: piecesAt,
    alignedAt: alignedAt,
    isAligned: isAligned,
    atEnd: atEnd,
    moveForward: moveForward,
    moveAlignedForward: moveAlignedForward,
    moveBackward: moveBackward,
    canMoveBackward: canMoveBackward
  };
})();


var BoardRender = (function(){

  var SVG_NS = "http://www.w3.org/2000/svg";
  // Sector angular layout (SVG math: 0°=right, angles in degrees; we render with y flipped so +angle goes up).
  // Three sectors spread evenly. Start them so the seams look natural.
  var SECTOR_ARRANGEMENT = [
    { id: 0, a0: 30,  a1: 150 },  // top
    { id: 1, a0: 150, a1: 270 },  // bottom-left
    { id: 2, a0: 270, a1: 390 }   // bottom-right
  ];

  var BG_COLORS = ["#c9a4d4","#b089c2","#9b6db2"]; // three shades for each sector bg
  var R_INNER = 50;    // inner void radius (nothing drawn inside)
  var R_OUTER = 460;   // outer ring radius
  var R_PATH_START = 100;
  var R_PATH_END = 430;

  var state = {
    svg: null,
    opts: null,
    sectorAssignments: null, // {research:'easy', ...}
    slotPositions: null,     // { easy:[{x,y}...], medium:[...], hard:[...] }
    highlightSlots: null,    // {sector, slots:[int]} for movement targets
    highlightPieces: null    // array of pieceId for selection/backward candidates
  };

  function toXY(r, degrees) {
    var rad = degrees * Math.PI / 180;
    return { x: r * Math.cos(rad), y: -r * Math.sin(rad) };
  }

  function arcPath(r, a0, a1) {
    var p0 = toXY(r, a0);
    var p1 = toXY(r, a1);
    var large = (a1 - a0) > 180 ? 1 : 0;
    return "M " + p0.x + " " + p0.y + " A " + r + " " + r + " 0 " + large + " 0 " + p1.x + " " + p1.y;
  }

  function sectorWedgePath(a0, a1) {
    var pIn0 = toXY(R_INNER, a0), pIn1 = toXY(R_INNER, a1);
    var pOut0 = toXY(R_OUTER, a0), pOut1 = toXY(R_OUTER, a1);
    var large = (a1-a0) > 180 ? 1 : 0;
    return [
      "M", pIn0.x, pIn0.y,
      "L", pOut0.x, pOut0.y,
      "A", R_OUTER, R_OUTER, 0, large, 0, pOut1.x, pOut1.y,
      "L", pIn1.x, pIn1.y,
      "A", R_INNER, R_INNER, 0, large, 1, pIn0.x, pIn0.y,
      "Z"
    ].join(" ");
  }

  // Produce slot positions for a sector with given length, within angular range [a0,a1].
  function layoutSlots(a0, a1, length) {
    var positions = [];
    var span = a1 - a0;
    var aMid = (a0 + a1) / 2;
    for (var i = 0; i < length; i++) {
      var t = length === 1 ? 0 : i / (length - 1);
      // radius grows; leave a margin at both ends
      var r = R_PATH_START + t * (R_PATH_END - R_PATH_START);
      // gentle S-curve; amplitude shrinks near the ends so start/end sit near the midline
      var amp = span * 0.32 * Math.sin(Math.PI * t);
      var phase = t * Math.PI * (length > 10 ? 2.2 : 1.4);
      var a = aMid + Math.sin(phase) * amp;
      positions.push(toXY(r, a));
    }
    return positions;
  }

  function el(tag, attrs, parent) {
    var e = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function(k){ e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // Initialize the SVG. sectorAssignments maps teamId -> sectorId (easy/medium/hard).
  // The three physical sectors on-screen are positions 0,1,2; we assign a sector difficulty to each.
  // For layout determinism, we assign difficulties to positions in a fixed order based on team ids.
  function init(svg, opts) {
    state.svg = svg;
    state.opts = opts || {};
    svg.setAttribute("viewBox", "-500 -500 1000 1000");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  }

  // Call when sectors are assigned. assignment: {position:0, sector:'easy', team:'research'} * 3
  function setSectors(assignment) {
    state.sectorAssignments = assignment;
    state.slotPositions = {};
    assignment.forEach(function(a){
      var arr = SECTOR_ARRANGEMENT[a.position];
      state.slotPositions[a.sector] = layoutSlots(arr.a0, arr.a1, SECTOR_LENGTHS[a.sector]);
      state.slotPositions[a.sector]._sectorArr = arr;
    });
  }

  function render(boardState) {
    if (!state.svg || !state.sectorAssignments) return;
    clear(state.svg);

    // Background wedges
    state.sectorAssignments.forEach(function(a, idx){
      var arr = SECTOR_ARRANGEMENT[a.position];
      el("path", {
        d: sectorWedgePath(arr.a0, arr.a1),
        fill: BG_COLORS[idx % BG_COLORS.length],
        stroke: "#5a3a6e",
        "stroke-width": 3
      }, state.svg);

      // Label: team + difficulty
      var labelPos = toXY(R_OUTER * 0.78, (arr.a0 + arr.a1)/2);
      var labelText = TEAMS[a.team].short + " · " + SECTOR_LABELS[a.sector];
      var textEl = el("text", {
        x: labelPos.x, y: labelPos.y,
        "text-anchor": "middle", "dominant-baseline": "middle",
        "font-family": "system-ui, sans-serif",
        "font-size": 20, "font-weight": 700,
        fill: "#fff",
        opacity: 0.85,
        "pointer-events": "none"
      }, state.svg);
      textEl.textContent = labelText;
    });

    // Goal glyph at center
    el("circle", { cx: 0, cy: 0, r: R_INNER - 6, fill: "#fff", stroke: "#5a3a6e", "stroke-width": 3 }, state.svg);
    var impactText = el("text", {
      x:0, y:0, "text-anchor":"middle", "dominant-baseline":"middle",
      "font-size": 13, "font-family":"system-ui,sans-serif", "font-weight": 700, fill:"#5a3a6e",
      "pointer-events":"none"
    }, state.svg);
    impactText.textContent = "IMPACT";

    // Slots + dashed path between them
    state.sectorAssignments.forEach(function(a){
      var pos = state.slotPositions[a.sector];
      if (!pos) return;
      // Dashed path connecting consecutive slots
      for (var i = 0; i < pos.length - 1; i++) {
        el("line", {
          x1: pos[i].x, y1: pos[i].y, x2: pos[i+1].x, y2: pos[i+1].y,
          stroke:"#fff", "stroke-width":2, "stroke-dasharray":"4 5", opacity: 0.7, "pointer-events":"none"
        }, state.svg);
      }
      // Slots
      for (var j = 0; j < pos.length; j++) {
        var isStart = (j === 0);
        var isEnd = (j === pos.length - 1);
        var r = isEnd ? 26 : (isStart ? 18 : 16);
        var slotEl = el("circle", {
          cx: pos[j].x, cy: pos[j].y, r: r,
          fill: "#fff", stroke: "#5a3a6e", "stroke-width": 2.5,
          "data-sector": a.sector, "data-slot": j,
          class: "bc-slot"
        }, state.svg);
        if (state.highlightSlots) {
          var hit = state.highlightSlots.some(function(h){ return h.sector === a.sector && h.slots.indexOf(j) !== -1; });
          if (hit) {
            slotEl.setAttribute("stroke", "#ffd400");
            slotEl.setAttribute("stroke-width", "5");
          }
        }
        if (state.opts.interactive && state.opts.onSlotClick) {
          slotEl.style.cursor = "pointer";
          slotEl.addEventListener("click", (function(sec, slot){ return function(){ state.opts.onSlotClick(sec, slot); }; })(a.sector, j));
        }
      }
    });

    // Pieces
    boardState.pieces.forEach(function(p){
      if (p.removed) return;
      var pos = state.slotPositions[p.sector];
      if (!pos || !pos[p.slot]) return;
      var here = Board.piecesAt(boardState, p.sector, p.slot);
      var idx = here.indexOf(p);
      var count = here.length;
      // Offset within slot when more than one piece present
      var offset = { x: 0, y: 0 };
      if (count > 1) {
        var ang = (idx / count) * Math.PI * 2;
        offset.x = Math.cos(ang) * 8;
        offset.y = Math.sin(ang) * 8;
      }
      var aligned = Board.isAligned(boardState, p);
      var pieceEl = el("circle", {
        cx: pos[p.slot].x + offset.x,
        cy: pos[p.slot].y + offset.y,
        r: 10,
        fill: PIECE_COLORS[p.color],
        stroke: aligned ? "#ffd400" : "#fff",
        "stroke-width": aligned ? 4 : 2,
        "data-piece-id": p.id,
        class: "bc-piece"
      }, state.svg);
      if (state.highlightPieces && state.highlightPieces.indexOf(p.id) !== -1) {
        pieceEl.setAttribute("stroke", "#00ff88");
        pieceEl.setAttribute("stroke-width", "4");
      }
      if (state.opts.interactive && state.opts.onPieceClick) {
        pieceEl.style.cursor = "pointer";
        pieceEl.addEventListener("click", (function(id){ return function(ev){ ev.stopPropagation(); state.opts.onPieceClick(id); }; })(p.id));
      }
    });
  }

  function setHighlightSlots(sector, slots) {
    state.highlightSlots = slots ? [{ sector: sector, slots: slots }] : null;
  }
  function setHighlightSlotsMulti(list) {
    state.highlightSlots = (list && list.length) ? list.slice() : null;
  }
  function setHighlightPieces(ids) { state.highlightPieces = ids; }

  return {
    init: init,
    setSectors: setSectors,
    render: render,
    setHighlightSlots: setHighlightSlots,
    setHighlightSlotsMulti: setHighlightSlotsMulti,
    setHighlightPieces: setHighlightPieces,
    SECTOR_ARRANGEMENT: SECTOR_ARRANGEMENT
  };
})();

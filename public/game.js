// Tic-tac-toe vs. the computer. Player is X and starts; computer is O (minimax, random among equally good moves).
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export function winnerOf(board) {
  for (const l of LINES) { const v = board[l[0]]; if (v && v === board[l[1]] && v === board[l[2]]) return { who: v, line: l }; }
  if (board.every(Boolean)) return { who: 'draw', line: null };
  return null;
}

function minimax(board, me, turn) {
  const w = winnerOf(board);
  if (w) return w.who === 'draw' ? 0 : w.who === me ? 1 : -1;
  let best = turn === me ? -2 : 2;
  for (let i = 0; i < 9; i++) {
    if (board[i]) continue;
    board[i] = turn;
    const v = minimax(board, me, turn === 'X' ? 'O' : 'X');
    board[i] = null;
    best = turn === me ? Math.max(best, v) : Math.min(best, v);
  }
  return best;
}

export function bestMove(board, me = 'O') {
  const scored = [];
  for (let i = 0; i < 9; i++) {
    if (board[i]) continue;
    board[i] = me; scored.push({ i, v: minimax(board, me, me === 'X' ? 'O' : 'X') }); board[i] = null;
  }
  const top = Math.max(...scored.map(s => s.v));
  const cands = scored.filter(s => s.v === top);
  return cands[Math.floor(Math.random() * cands.length)].i;
}

export class TicTacToe {
  constructor() { this.reset(); }
  reset() { this.board = Array(9).fill(null); this.turn = 'X'; this.result = null; this.lastMove = -1; this.lastPlayerCell = -1; this.marks = {}; return this.state(); }
  /** Player places X in cell. Returns false when the move is illegal. */
  playerMove(cell) {
    if (this.result || this.turn !== 'X' || cell < 0 || this.board[cell]) return false;
    this.board[cell] = 'X'; this.lastMove = cell; this.lastPlayerCell = cell; this.turn = 'O';
    this.result = winnerOf(this.board);
    return true;
  }
  /** True while the player may still add strokes to the cell they just marked (finishing their X). */
  canEmbellish(cell) { return !this.result && this.turn === 'O' && cell === this.lastPlayerCell; }
  computerMove() {
    if (this.result || this.turn !== 'O') return -1;
    const i = bestMove(this.board, 'O');
    this.board[i] = 'O'; this.lastMove = i; this.turn = 'X'; this.marks[i] = performance.now();
    this.result = winnerOf(this.board);
    return i;
  }
  message() {
    if (this.result?.who === 'X') return 'You win! 🎉';
    if (this.result?.who === 'O') return 'Computer wins';
    if (this.result?.who === 'draw') return 'Draw';
    return this.turn === 'X' ? 'Your turn — draw an X in a cell' : 'Computer is thinking…';
  }
  state() { return { board: [...this.board], turn: this.turn, result: this.result, marks: { ...this.marks }, message: this.message() }; }
}

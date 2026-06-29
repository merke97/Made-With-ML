import { Container, Text, type TextStyleOptions } from "pixi.js";

// A pool of reusable Text objects. Recreating Text every frame is expensive and
// GC-heavy, so we keep a growing pool and just reassign text/position/alpha,
// hiding the leftovers. One pool per role (ruler ticks, labels, titles).
export class TextPool {
  private pool: Text[] = [];
  private cursor = 0;
  constructor(
    private container: Container,
    private style: TextStyleOptions,
  ) {}

  begin() {
    this.cursor = 0;
  }

  next(text: string, x: number, y: number, alpha: number, tint = 0xffffff): Text {
    let t = this.pool[this.cursor];
    if (!t) {
      t = new Text({ text, style: this.style });
      t.resolution = 2;
      this.pool.push(t);
      this.container.addChild(t);
    }
    if (t.text !== text) t.text = text;
    t.x = Math.round(x);
    t.y = Math.round(y);
    t.alpha = alpha;
    t.tint = tint;
    t.visible = alpha > 0.01;
    this.cursor++;
    return t;
  }

  end() {
    for (let i = this.cursor; i < this.pool.length; i++) this.pool[i].visible = false;
  }
}

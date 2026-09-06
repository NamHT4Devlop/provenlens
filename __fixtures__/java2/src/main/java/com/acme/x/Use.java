package com.acme.x;

import static com.acme.a.Helper.compute;
import com.acme.a.Helper;
import com.acme.a.Overloads;
import com.acme.a.Entity;
import com.acme.a.Base;
import com.acme.a.Color;
import java.util.function.Supplier;

public class Use extends Base implements Runnable, // trailing comment
    java.io.Serializable {
  public Use() { this(1); }
  public Use(int x) { super(x); }

  void staticImport() { compute(); }

  void varTyping() {
    Helper h = new Helper();
    var v = h.first(h.second());
    v.fooOnly();
  }

  void refs() {
    Supplier<Integer> s = Helper::compute;
    Runnable r = this::run;
    Supplier<Helper> n = Helper::new;
  }

  public void run() { }

  void comments(Overloads o) {
    o.f(1 /* first */, 2);
    o.h("a", "b", "c");
    o.f(1, 2, 3, 4);
  }

  <Entity> void each(Entity e) { e.hashCode(); }

  void nested() {
    Helper.Inner.create().innerTag();
    com.acme.a.Helper.compute();
  }

  void patterns(Object o) {
    if (o instanceof Helper hh) hh.tag();
    for (var h : new Helper[0]) h.tag();
  }

  void typedLambda() {
    java.util.function.Consumer<Helper> c = (Helper hh) -> hh.tag();
  }

  void enums() {
    Color.RED.label();
  }
}

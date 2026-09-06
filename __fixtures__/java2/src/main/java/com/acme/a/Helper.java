package com.acme.a;

public class Helper {
  public static int compute() { return 1; }
  public static Helper make() { return new Helper(); }
  public void tag() { }
  public Bar second() { return new Bar(); }
  public Foo first(Bar b) { return new Foo(); }
  public static class Inner {
    public static Inner create() { return new Inner(); }
    public void innerTag() { }
  }
}

package com.acme.a;

public enum Color {
  RED("r") {
    @Override public String label() { return "red"; }
  },
  GREEN("g");

  private final String code;
  Color(String code) { this.code = code; }
  public String label() { return code; }
}

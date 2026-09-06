package com.p;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
  @GetMapping("/{id}")
  public String get(@PathVariable long id) { return ""; }

  @PostMapping
  public String create() { return ""; }

  @RequestMapping(value = "/bulk", method = RequestMethod.POST)
  public String bulk() { return ""; }

  @GetMapping(produces = "application/json", value = "/list")
  public String list() { return ""; }

  @GetMapping({"/a", "/b"})
  public String either() { return ""; }
}

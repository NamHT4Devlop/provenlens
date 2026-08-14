package com.acme.service;

public abstract class BaseService {

    protected void audit(String action) {
        System.out.println("[audit] " + action);
    }

    protected boolean isEnabled() {
        return true;
    }
}

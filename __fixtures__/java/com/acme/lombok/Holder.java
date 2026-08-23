package com.acme.lombok;

import java.util.function.Function;

public class Holder<T> {
    public <R> Holder<R> map(Function<T, R> mapper) {
        return null;
    }
}

package com.acme.lombok;

import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class Receipt {
    private Long id;
    private String note;
    private boolean settled;
}

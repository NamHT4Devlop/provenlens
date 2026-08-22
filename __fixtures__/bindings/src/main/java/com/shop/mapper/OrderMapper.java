package com.shop.mapper;

import java.util.List;
import org.apache.ibatis.annotations.Mapper;

/** No implementation exists in the source: MyBatis builds one from the XML. */
@Mapper
public interface OrderMapper {
    Order findById(Long id);

    List<Order> findAll();

    int insertOrder(Order order);
}

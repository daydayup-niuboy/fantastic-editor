# 资源安全

![远程](https://example.com/image.png)

![内嵌](data:image/png;base64,DO_NOT_COPY_THIS_PAYLOAD)

![盘符相对](C:images\photo.png)

![非法编码](images/bad%ZZ.png)

<img src="private.png" onerror="alert(1)">

```md
![代码示例](data:image/png;base64,SHOULD_NOT_PARSE)
<img src="also-not-a-resource.png">
```
"use strict";

import {create} from "./builder.js"

const ERRORS = [
    "SUCCESS",
    "UNEXPECTED_TOKEN",
    "BOUNDARY",
    "COMPLETE",
]

const {
    ERROR, NODE, CONSUME, SPAN, ON_MATCH, CALLBACK,
    parser, header, source, enumeration, include, callback
} = create({
    name: "multipart_parser", 
    errors: ERRORS, 
    props: {
        "boundary": "ptr",
        "boundary_length": "i8",
        "boundary_origin_": "i8",
        "boundary_offset_": "i8",
        "epoch_": "i16",
    }
})

export async function build(__src) {
    await parser("begin")
        .output(__src)
    await header("multipart_core")
        .append( enumeration("multipart_parser_error").comment("错误编码").fromArray(ERRORS) )
        .output(__src)
    await source("multipart_core")
        .append( include("multipart_core.h") )
        .append( include("multipart_parser.h") )
        .append( include("string.h").system() )
        .append( callback("begin")
            .comment("初始化 boundary 长度，标记解析世代")
            .body(`
    if(s->boundary_length == 0) s->boundary_length = strlen(s->boundary);
    s->epoch_ = 0; // 重新开始解析的标志
    return !(s->boundary_length > 0);`) )
        .append( callback("before_boundary_match")
            .comment("重置 OFFSET 匹配位置")
            .body(`
    s->boundary_origin_ = s->boundary_length;
    s->boundary_offset_ = 0;
    return 0;`) )
        .append( callback("on_data").comment("代理错误的 BOUNDARY 匹配") )
        .append(`
static unsigned char eol[2] = "\\r\\n";`)
        .append( callback("on_boundary").comment("匹配 BOUNDARY 数据").body(`
    const unsigned char* boundary = (unsigned char*)s->boundary;
    if(s->boundary_offset_ > s->boundary_length) { // 已匹配失败
        if(endp > p) ${CALLBACK("on_data")}(s, p, endp);
        return 0;
    }
    if(memcmp(boundary + s->boundary_offset_, p, endp - p) != 0) { // 本次匹配失败
        if(s->epoch_ > 0) { // 首个 boundary 匹配失败报错
            ${CALLBACK("on_data")}(s, eol, eol+2);
            ${CALLBACK("on_data")}(s, boundary, boundary + s->boundary_offset_);
            ${CALLBACK("on_data")}(s, p, endp);
            s->boundary_offset_ = -1;
        }
        return 0;
    }
    s->boundary_offset_ += endp - p;
    return 0;`))
        .append( callback("on_data_emit").comment("单个数据区结束") )
        .append( callback("match_boundary").comment("检查 BOUNDARY 是否完整匹配").body(`
    if(s->boundary_origin_ == 0 && s->boundary_offset_ == s->boundary_length) {
        if(++s->epoch_ > 1) ${CALLBACK("on_data_emit")}(s, p, endp);
        return 1;
    }
    else if(s->epoch_ == 0) return 2; // 首个区块必须以 boundary 开始
    else return 0;`) )
        .output(__src)
}

ON_MATCH("begin")
    .match(0, NODE("before_boundary_0") )
    .otherwise( ERROR("BOUNDARY", "on_boundary_length") )

NODE("before_boundary_0")
    .match("--", ON_MATCH("before_boundary_match"))
    .otherwise( ERROR("UNEXPECTED_TOKEN", "before_boundary_0") )

NODE("before_boundary_1")
    .match("\r\n--", ON_MATCH("before_boundary_match"))
    // 假命中
    .otherwise( SPAN("on_data").start( NODE("data_ex") ))

ON_MATCH("before_boundary_match")
    .otherwise( SPAN("on_boundary").start( CONSUME("boundary") ))

CONSUME("boundary")
    .consume("boundary_origin_")
    .otherwise( SPAN("on_boundary").end( ON_MATCH("match_boundary") ))

ON_MATCH("match_boundary")
    .match(1, NODE("after_boundary") )
    .match(2, ERROR("UNEXPECTED_TOKEN", "match_boundary"))
    .otherwise( SPAN("on_data").start( NODE("data") ))

NODE("after_boundary")
    .match("\r\n", SPAN("on_field").start( NODE("field") ))
    .match("--", ON_MATCH("on_complete") )
    .otherwise( ERROR("UNEXPECTED_TOKEN", "after_boundary")  )

NODE("before_field")
    .match("\r\n", SPAN("on_field").start( NODE("field") ))
    .otherwise( ERROR("UNEXPECTED_TOKEN", "before_field") )

NODE("field")
    .peek([":", "\r", "\n"], SPAN("on_field").end( ON_MATCH("on_field_emit") ))
    .skipTo( NODE("field") )

ON_MATCH("on_field_emit")
    .otherwise( NODE("before_value") )

NODE("before_value")
    .match([":"," "], NODE("before_value"))
    .match(["\r", "\n"], ON_MATCH("on_value_emit"))
    .otherwise(SPAN("on_value").start(NODE("value")))

NODE("value")
    .peek("\r", SPAN("on_value").end( ON_MATCH("on_value_emit") ))
    .skipTo(NODE("value"));

ON_MATCH("on_value_emit")
    .otherwise(NODE("after_value_1"))

NODE("after_value_1")
    .match("\r\n", NODE("after_value_2"))
    .otherwise( ERROR("UNEXPECTED_TOKEN", "after_value_1") )

NODE("after_value_2")
    .match("\r\n", SPAN("on_data").start( NODE("data") ))
    .otherwise(SPAN("on_field").start( NODE("field") ))

NODE("data")
    .peek("\r", SPAN("on_data").end( NODE("before_boundary_1") ))
    .skipTo( NODE("data") )

NODE("data_ex")
    .skipTo(NODE("data"))

ON_MATCH("on_complete")
    .match(0, ON_MATCH("begin"))
    .otherwise( ERROR("COMPLETE", "complete") )

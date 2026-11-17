import { expect, test } from "bun:test"
import { windowBounds } from "../src/agent/window-bounds"

const desktop = { left:0, top:0, width:1280, height:800, playerTop:730 }

test("opens bottom-right above transport and allows movement on both axes", () => {
  expect(windowBounds(desktop,null)).toEqual({left:852,top:212,width:420,height:510})
  expect(windowBounds(desktop,{x:48,y:28})).toEqual({left:48,top:28,width:420,height:510})
  expect(windowBounds(desktop,{x:-1000,y:-1000})).toMatchObject({left:8,top:8})
})

test("old desktop coordinates and out-of-bounds drags stay reachable on a phone", () => {
  const bounds = windowBounds({...desktop,width:360,height:640,playerTop:570},{x:900,y:900})
  expect(bounds.left+bounds.width).toBe(352)
  expect(bounds.top+bounds.height).toBe(562)
  expect(bounds.width).toBeLessThan(344) // still movable horizontally
})

test("visible viewport after keyboard or zoom, without double-counting the hidden player", () => {
  const view = {left:36,top:95,width:240,height:235,playerTop:730}
  expect(windowBounds(view,{x:0,y:900})).toEqual({left:44,top:103,width:224,height:219})
})

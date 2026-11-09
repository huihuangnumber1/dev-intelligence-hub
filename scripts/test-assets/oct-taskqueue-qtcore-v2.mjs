// Asset version 2. Production TaskQueue regression in an offline Windows LPAC.
// Deployment supplies a hash-pinned oct-toolchain resource; no installed host
// toolchain path or registry discovery is used by this asset.
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
const resources = process.env.CONTROLLED_TEST_RESOURCES;
if (!resources || !path.isAbsolute(resources)) { console.error("Missing configured toolchain resources"); process.exit(69); }
const tools = path.join(resources, "oct-toolchain");
const production = path.join(process.cwd(), "Source/Common");
const compiler = path.join(tools, "msvc/bin/cl.exe");
if (![compiler, path.join(tools,"qt/bin/Qt5Core.dll"), path.join(production,"TaskQueue.cpp"), path.join(production,"TaskQueue.h")].every(existsSync)) { console.error("Pinned TaskQueue sources or narrow compiler snapshot missing"); process.exit(69); }
const build = mkdtempSync(path.join(process.cwd(), ".controlled-taskqueue-build-"));
const harness = String.raw`#include "TaskQueue.h"
#include <QCoreApplication>
#include <QThread>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <vector>
bool serialTasks() {
  std::atomic<int> active(0); std::atomic<bool> overlap(false); std::vector<int> order; std::mutex orderMutex;
  { Util::TaskQueue queue;
    for(int i=0;i<64;i++) queue.addTask([&,i]{
      if(++active>1) overlap=true;
      QThread::msleep(1); {std::lock_guard<std::mutex> lock(orderMutex); order.push_back(i);} --active;
    });
  }
  if(overlap || order.size()!=64) return false;
  for(int i=0;i<64;i++) if(order[i]!=i) return false;
  return true;
}
bool destructionWaits() {
  std::atomic<int> finished(0);
  { Util::TaskQueue queue;
    for(int i=0;i<32;i++) queue.addTask([&]{QThread::msleep(2); ++finished;});
  }
  return finished==32;
}
bool independentQueues() {
  std::mutex mutex; std::condition_variable condition;
  bool entered=false, released=false, completed=false;
  Util::TaskQueue first, second;
  first.addTask([&]{
    std::unique_lock<std::mutex> lock(mutex); entered=true; condition.notify_all();
    completed=condition.wait_for(lock,std::chrono::seconds(3),[&]{return released;});
    condition.notify_all();
  });
  { std::unique_lock<std::mutex> lock(mutex);
    if(!condition.wait_for(lock,std::chrono::seconds(3),[&]{return entered;})) return false;
  }
  second.addTask([&]{std::lock_guard<std::mutex> lock(mutex); released=true; condition.notify_all();});
  { std::unique_lock<std::mutex> lock(mutex);
    if(!condition.wait_for(lock,std::chrono::seconds(3),[&]{return completed;})) return false;
  }
  return completed;
}
int main(int argc,char **argv) {
  QCoreApplication application(argc,argv);
  const char *names[]={"production TaskQueue serial ordering","destructor drains production tasks","production queue instances execute independently"};
  bool results[]={serialTasks(),destructionWaits(),independentQueues()}; int passed=0;
  std::cout<<"TAP version 13\n";
  for(int i=0;i<3;i++){if(results[i])++passed; std::cout<<(results[i]?"ok ":"not ok ")<<i+1<<" - "<<names[i]<<"\n";}
  std::cout<<"1..3\n# tests 3\n# pass "<<passed<<"\n# fail "<<3-passed<<"\n# cancelled 0\n# skipped 0\n# todo 0\n";
  return passed==3?0:1;
}`;
writeFileSync(path.join(build,"TaskQueueRegression.cpp"),harness);
const executable = path.join(build,"ControlledTaskQueueTest.exe");
const environment = { ...process.env,
  PATH: [path.join(tools,"msvc/bin"),path.join(tools,"qt/bin"),path.join(process.env.SystemRoot,"System32")].join(";"),
  INCLUDE: ["msvc/include","qt/include","qt/include/QtCore","sdk/include/ucrt","sdk/include/um","sdk/include/shared"].map(value=>path.join(tools,value)).join(";"),
  LIB: ["msvc/lib","qt/lib","sdk/lib/ucrt","sdk/lib/um"].map(value=>path.join(tools,value)).join(";") };
const compiled = spawnSync(compiler,["/nologo","/EHsc","/MD","/O2","/DQT_CORE_LIB","/DQT_NO_DEBUG","/I"+production,path.join(build,"TaskQueueRegression.cpp"),path.join(production,"TaskQueue.cpp"),"/Fe:"+executable,"/link","Qt5Core.lib","/SUBSYSTEM:CONSOLE"],{cwd:build,env:environment,stdio:["ignore",2,2]});
if (compiled.error || compiled.status !== 0) process.exit(compiled.error ? 69 : compiled.status || 1);
if (!existsSync(executable)) { console.error("Compiler produced no fresh regression executable"); process.exit(1); }
console.error("Fresh TaskQueue regression executable sha256="+createHash("sha256").update(readFileSync(executable)).digest("hex"));
const tested = spawnSync(executable,[],{cwd:build,env:environment,stdio:"inherit"});
process.exitCode = tested.error ? 69 : tested.status ?? 1;

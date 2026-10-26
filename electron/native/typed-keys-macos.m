// Passive single-character display. No text history, file writes or networking.
#import <Foundation/Foundation.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Carbon/Carbon.h>
#include <signal.h>
#include <unistd.h>
static CFMachPortRef tap;
static int latest=-1;
static pid_t parentPID;
static CFAbsoluteTime nextCheck;
static int printable(CGEventRef event, bool secure) {
    if (secure) return -1;
    CGEventFlags flags=CGEventGetFlags(event);
    if (flags & (kCGEventFlagMaskCommand|kCGEventFlagMaskControl|kCGEventFlagMaskAlternate)) return -1;
    UniChar text[8]; UniCharCount count=0;
    CGEventKeyboardGetUnicodeString(event,8,&count,text);
    return count==1 && text[0]>=32 && text[0]<=126 ? text[0] : -1;
}
static CGEventRef observe(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *context) {
    if(type==kCGEventTapDisabledByTimeout || type==kCGEventTapDisabledByUserInput) {
        latest=-1;
        if(CGPreflightListenEventAccess()) CGEventTapEnable(tap,true);
        return event;
    }
    if(type==kCGEventKeyDown) latest=printable(event,IsSecureEventInputEnabled());
    return event; // listen-only, never suppress or inject a key
}
static void tick(CFRunLoopTimerRef timer, void *context) {
    CFAbsoluteTime now=CFAbsoluteTimeGetCurrent();
    if(now>=nextCheck) {
        nextCheck=now+1;
        if(getppid()!=parentPID || kill(parentPID,0)!=0) { CFRunLoopStop(CFRunLoopGetCurrent()); return; }
        if(!CGPreflightListenEventAccess()) { puts("ERROR:PERMISSION"); CFRunLoopStop(CFRunLoopGetCurrent()); return; }
    }
    if(IsSecureEventInputEnabled()) { latest=-1; return; }
    if(latest>=0) { int value=latest;latest=-1;printf("KEY:%d\n",value); }
}
static int selfTest(void) {
    CGEventRef event=CGEventCreateKeyboardEvent(NULL,0,true);
    if(!event)return 1;
    for(int code=0;code<160;code++) {
        UniChar value=code;CGEventKeyboardSetUnicodeString(event,1,&value);CGEventSetFlags(event,0);
        if(printable(event,false)!=(code>=32&&code<=126?code:-1))return 2;
        if(printable(event,true)!=-1)return 3;
    }
    for(int i=0;i<3;i++) {
        UniChar value='A';CGEventKeyboardSetUnicodeString(event,1,&value);
        CGEventSetFlags(event,(CGEventFlags[]){kCGEventFlagMaskCommand,kCGEventFlagMaskControl,kCGEventFlagMaskAlternate}[i]);
        if(printable(event,false)!=-1)return 4;
    }
    UniChar pair[2]={'a','b'};CGEventSetFlags(event,0);CGEventKeyboardSetUnicodeString(event,2,pair);
    if(printable(event,false)!=-1)return 5;
    CFRelease(event);puts("SELFTEST:OK");return 0;
}
int main(int argc,const char *argv[]) { @autoreleasepool {
    setvbuf(stdout,NULL,_IOLBF,0);
    if(argc==2 && strcmp(argv[1],"--self-test")==0)return selfTest();
    if(argc==2 && strcmp(argv[1],"--request-permission")==0) {
        puts(CGRequestListenEventAccess()?"PERMISSION:GRANTED":"PERMISSION:PENDING");return 0;
    }
    if(argc!=3 || strcmp(argv[1],"--parent-pid")!=0)return 64;
    char *end=NULL;long pid=strtol(argv[2],&end,10);
    if(!end || *end || pid<=1 || pid>INT_MAX)return 64;
    parentPID=(pid_t)pid;
    if(getppid()!=parentPID)return 0;
    if(!CGPreflightListenEventAccess()) {puts("ERROR:PERMISSION");return 77;}
    tap=CGEventTapCreate(kCGSessionEventTap,kCGTailAppendEventTap,kCGEventTapOptionListenOnly,
        CGEventMaskBit(kCGEventKeyDown),observe,NULL);
    if(!tap) {puts("ERROR:UNAVAILABLE");return 78;}
    CFRunLoopSourceRef source=CFMachPortCreateRunLoopSource(NULL,tap,0);
    if(!source){CFRelease(tap);return 78;}
    CFRunLoopAddSource(CFRunLoopGetCurrent(),source,kCFRunLoopCommonModes);
    CFRunLoopTimerRef timer=CFRunLoopTimerCreate(NULL,CFAbsoluteTimeGetCurrent()+.01,.01,0,0,tick,NULL);
    if(!timer){CFRelease(source);CFRelease(tap);return 78;}
    CFRunLoopAddTimer(CFRunLoopGetCurrent(),timer,kCFRunLoopCommonModes);
    CGEventTapEnable(tap,true);puts("READY");CFRunLoopRun();
    latest=-1;CGEventTapEnable(tap,false);
    CFRunLoopTimerInvalidate(timer);CFRelease(timer);CFRelease(source);CFRelease(tap);return 0;
}}

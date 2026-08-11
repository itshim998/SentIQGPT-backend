# Flutter's generated rules cover the engine and plugin registrant. Keep the
# native payment SDK classes that are discovered reflectively at runtime.
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
-keep class com.razorpay.** { *; }
-dontwarn com.razorpay.**
